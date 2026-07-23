#![cfg(mobile)]

//! Android-only encrypted persistence for the embedded controller. The key is
//! generated inside AndroidKeyStore and is never materialized in Rust or JS.

use std::{fs, path::PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};

const STORE_FILE: &str = "mobile-gateway-state.json";

#[derive(Deserialize, Serialize)]
struct EncryptedBlob {
    version: u8,
    iv: String,
    ciphertext: String,
}

fn store_path() -> PathBuf {
    dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("ZeroAgent")
        .join(STORE_FILE)
}

#[cfg(target_os = "android")]
mod platform {
    use std::sync::OnceLock;

    use jni::{
        objects::{JByteArray, JObject, JValue},
        sys::{jint, JavaVM as RawJavaVm, JNI_VERSION_1_6},
        JNIEnv, JavaVM,
    };

    const KEY_ALIAS: &str = "com.tkxs.zerobox.mobile_gateway_state.v1";
    const ENCRYPT_MODE: i32 = 1;
    const DECRYPT_MODE: i32 = 2;
    const PURPOSE_ENCRYPT_DECRYPT: i32 = 3;
    const GCM_TAG_BITS: i32 = 128;

    static JVM: OnceLock<JavaVM> = OnceLock::new();

    #[no_mangle]
    pub unsafe extern "system" fn JNI_OnLoad(vm: *mut RawJavaVm, _: *mut std::ffi::c_void) -> jint {
        if let Ok(vm) = JavaVM::from_raw(vm) {
            let _ = JVM.set(vm);
            JNI_VERSION_1_6
        } else {
            0
        }
    }

    fn with_env<T>(operation: impl FnOnce(&mut JNIEnv) -> Result<T, String>) -> Result<T, String> {
        let vm = JVM.get().ok_or_else(|| {
            "Android Keystore is unavailable before the app runtime starts".to_string()
        })?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|error| format!("attach Android runtime: {error}"))?;
        operation(&mut env)
    }

    fn java_error(error: impl std::fmt::Display) -> String {
        format!("Android Keystore operation failed: {error}")
    }

    fn android_key<'local>(env: &mut JNIEnv<'local>) -> Result<JObject<'local>, String> {
        let store_type = env.new_string("AndroidKeyStore").map_err(java_error)?;
        let store = env
            .call_static_method(
                "java/security/KeyStore",
                "getInstance",
                "(Ljava/lang/String;)Ljava/security/KeyStore;",
                &[JValue::Object(&store_type)],
            )
            .map_err(java_error)?
            .l()
            .map_err(java_error)?;
        env.call_method(
            &store,
            "load",
            "(Ljava/security/KeyStore$LoadStoreParameter;)V",
            &[JValue::Object(&JObject::null())],
        )
        .map_err(java_error)?;

        let alias = env.new_string(KEY_ALIAS).map_err(java_error)?;
        let exists = env
            .call_method(
                &store,
                "containsAlias",
                "(Ljava/lang/String;)Z",
                &[JValue::Object(&alias)],
            )
            .map_err(java_error)?
            .z()
            .map_err(java_error)?;
        if !exists {
            let aes = env.new_string("AES").map_err(java_error)?;
            let provider = env.new_string("AndroidKeyStore").map_err(java_error)?;
            let generator = env
                .call_static_method(
                    "javax/crypto/KeyGenerator",
                    "getInstance",
                    "(Ljava/lang/String;Ljava/lang/String;)Ljavax/crypto/KeyGenerator;",
                    &[JValue::Object(&aes), JValue::Object(&provider)],
                )
                .map_err(java_error)?
                .l()
                .map_err(java_error)?;
            let builder_alias = env.new_string(KEY_ALIAS).map_err(java_error)?;
            let builder = env
                .new_object(
                    "android/security/keystore/KeyGenParameterSpec$Builder",
                    "(Ljava/lang/String;I)V",
                    &[
                        JValue::Object(&builder_alias),
                        JValue::Int(PURPOSE_ENCRYPT_DECRYPT),
                    ],
                )
                .map_err(java_error)?;
            let modes = env
                .new_object_array(1, "java/lang/String", JObject::null())
                .map_err(java_error)?;
            let gcm = env.new_string("GCM").map_err(java_error)?;
            env.set_object_array_element(&modes, 0, gcm)
                .map_err(java_error)?;
            env.call_method(
                &builder,
                "setBlockModes",
                "([Ljava/lang/String;)Landroid/security/keystore/KeyGenParameterSpec$Builder;",
                &[JValue::Object(&modes)],
            )
            .map_err(java_error)?;
            let paddings = env
                .new_object_array(1, "java/lang/String", JObject::null())
                .map_err(java_error)?;
            let no_padding = env.new_string("NoPadding").map_err(java_error)?;
            env.set_object_array_element(&paddings, 0, no_padding)
                .map_err(java_error)?;
            env.call_method(
                &builder,
                "setEncryptionPaddings",
                "([Ljava/lang/String;)Landroid/security/keystore/KeyGenParameterSpec$Builder;",
                &[JValue::Object(&paddings)],
            )
            .map_err(java_error)?;
            let spec = env
                .call_method(
                    &builder,
                    "build",
                    "()Landroid/security/keystore/KeyGenParameterSpec;",
                    &[],
                )
                .map_err(java_error)?
                .l()
                .map_err(java_error)?;
            env.call_method(
                &generator,
                "init",
                "(Ljava/security/spec/AlgorithmParameterSpec;)V",
                &[JValue::Object(&spec)],
            )
            .map_err(java_error)?;
            env.call_method(&generator, "generateKey", "()Ljavax/crypto/SecretKey;", &[])
                .map_err(java_error)?;
        }
        let key = env
            .call_method(
                &store,
                "getKey",
                "(Ljava/lang/String;[C)Ljava/security/Key;",
                &[JValue::Object(&alias), JValue::Object(&JObject::null())],
            )
            .map_err(java_error)?
            .l()
            .map_err(java_error)?;
        if key.is_null() {
            return Err("Android Keystore did not return the mobile encryption key".to_string());
        }
        Ok(key)
    }

    fn cipher<'local>(env: &mut JNIEnv<'local>) -> Result<JObject<'local>, String> {
        let transformation = env.new_string("AES/GCM/NoPadding").map_err(java_error)?;
        env.call_static_method(
            "javax/crypto/Cipher",
            "getInstance",
            "(Ljava/lang/String;)Ljavax/crypto/Cipher;",
            &[JValue::Object(&transformation)],
        )
        .map_err(java_error)?
        .l()
        .map_err(java_error)
    }

    pub fn encrypt(data: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
        with_env(|env| {
            let key = android_key(env)?;
            let cipher = cipher(env)?;
            env.call_method(
                &cipher,
                "init",
                "(ILjava/security/Key;)V",
                &[JValue::Int(ENCRYPT_MODE), JValue::Object(&key)],
            )
            .map_err(java_error)?;
            let input = env.byte_array_from_slice(data).map_err(java_error)?;
            let encrypted = env
                .call_method(&cipher, "doFinal", "([B)[B", &[JValue::Object(&input)])
                .map_err(java_error)?
                .l()
                .map_err(java_error)?;
            let iv = env
                .call_method(&cipher, "getIV", "()[B", &[])
                .map_err(java_error)?
                .l()
                .map_err(java_error)?;
            Ok((
                env.convert_byte_array(JByteArray::from(encrypted))
                    .map_err(java_error)?,
                env.convert_byte_array(JByteArray::from(iv))
                    .map_err(java_error)?,
            ))
        })
    }

    pub fn decrypt(iv: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
        with_env(|env| {
            let key = android_key(env)?;
            let cipher = cipher(env)?;
            let iv = env.byte_array_from_slice(iv).map_err(java_error)?;
            let spec = env
                .new_object(
                    "javax/crypto/spec/GCMParameterSpec",
                    "(I[B)V",
                    &[JValue::Int(GCM_TAG_BITS), JValue::Object(&iv)],
                )
                .map_err(java_error)?;
            env.call_method(
                &cipher,
                "init",
                "(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V",
                &[
                    JValue::Int(DECRYPT_MODE),
                    JValue::Object(&key),
                    JValue::Object(&spec),
                ],
            )
            .map_err(java_error)?;
            let encrypted = env.byte_array_from_slice(data).map_err(java_error)?;
            let plain = env
                .call_method(&cipher, "doFinal", "([B)[B", &[JValue::Object(&encrypted)])
                .map_err(java_error)?
                .l()
                .map_err(java_error)?;
            env.convert_byte_array(JByteArray::from(plain))
                .map_err(java_error)
        })
    }
}

#[cfg(not(target_os = "android"))]
mod platform {
    pub fn encrypt(_: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
        Err("encrypted mobile storage is only available on Android".to_string())
    }

    pub fn decrypt(_: &[u8], _: &[u8]) -> Result<Vec<u8>, String> {
        Err("encrypted mobile storage is only available on Android".to_string())
    }
}

pub fn load() -> Result<Option<Vec<u8>>, String> {
    let path = store_path();
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read(&path).map_err(|error| format!("read encrypted mobile state: {error}"))?;
    let blob: EncryptedBlob = serde_json::from_slice(&raw)
        .map_err(|error| format!("parse encrypted mobile state: {error}"))?;
    if blob.version != 1 {
        return Err("encrypted mobile state uses an unsupported version".to_string());
    }
    let iv = BASE64
        .decode(blob.iv)
        .map_err(|_| "encrypted mobile state has an invalid IV".to_string())?;
    let ciphertext = BASE64
        .decode(blob.ciphertext)
        .map_err(|_| "encrypted mobile state has invalid ciphertext".to_string())?;
    platform::decrypt(&iv, &ciphertext).map(Some)
}

pub fn save(data: &[u8]) -> Result<(), String> {
    let (ciphertext, iv) = platform::encrypt(data)?;
    let blob = EncryptedBlob {
        version: 1,
        iv: BASE64.encode(iv),
        ciphertext: BASE64.encode(ciphertext),
    };
    let encoded = serde_json::to_vec(&blob)
        .map_err(|error| format!("serialize encrypted mobile state: {error}"))?;
    let path = store_path();
    let directory = path
        .parent()
        .ok_or_else(|| "mobile state directory is unavailable".to_string())?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("create mobile state directory: {error}"))?;
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, encoded)
        .map_err(|error| format!("write encrypted mobile state: {error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("commit encrypted mobile state: {error}"))
}

pub fn clear() -> Result<(), String> {
    let path = store_path();
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("clear encrypted mobile state: {error}"))?;
    }
    Ok(())
}
