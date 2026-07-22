use serde::{Deserialize, Serialize};

const CREDENTIAL_TARGET: &str = "ZeroBox/device-credential";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCredentialRecord {
    pub device_id: String,
    pub credential: String,
}

pub fn load_device_credential() -> Result<Option<DeviceCredentialRecord>, String> {
    let Some(value) = platform_load()? else {
        return Ok(None);
    };
    let record: DeviceCredentialRecord = serde_json::from_str(&value)
        .map_err(|error| format!("decode device credential: {error}"))?;
    if record.device_id.trim().is_empty() || record.credential.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(record))
}

pub fn save_device_credential(record: &DeviceCredentialRecord) -> Result<(), String> {
    if record.device_id.trim().is_empty() || record.credential.trim().is_empty() {
        return Err("device id and credential are required".to_string());
    }
    let value = serde_json::to_string(record)
        .map_err(|error| format!("encode device credential: {error}"))?;
    platform_save(&value)
}

#[tauri::command]
pub fn device_credential_get() -> Result<Option<DeviceCredentialRecord>, String> {
    load_device_credential()
}

#[tauri::command]
pub fn device_credential_set(record: DeviceCredentialRecord) -> Result<(), String> {
    save_device_credential(&record)
}

#[tauri::command]
pub fn device_credential_delete() -> Result<(), String> {
    platform_delete()
}

#[tauri::command]
pub fn device_default_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "ZeroAgent device".to_string())
}

#[tauri::command]
pub fn zeroagent_app_version() -> String {
    crate::app_version().to_string()
}

#[cfg(target_os = "windows")]
fn wide(value: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(target_os = "windows")]
fn platform_save(value: &str) -> Result<(), String> {
    use windows_sys::Win32::Security::Credentials::{
        CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };
    let mut target = wide(CREDENTIAL_TARGET);
    let mut username = wide("ZeroBox");
    let mut blob = value.as_bytes().to_vec();
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_mut_ptr(),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: username.as_mut_ptr(),
        ..Default::default()
    };
    let ok = unsafe { CredWriteW(&credential, 0) };
    if ok == 0 {
        return Err(format!(
            "write Windows Credential Manager entry failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn platform_load() -> Result<Option<String>, String> {
    use windows_sys::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };
    let target = wide(CREDENTIAL_TARGET);
    let mut pointer: *mut CREDENTIALW = std::ptr::null_mut();
    let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut pointer) };
    if ok == 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(1168) {
            return Ok(None);
        }
        return Err(format!(
            "read Windows Credential Manager entry failed: {error}"
        ));
    }
    let result = unsafe {
        let credential = &*pointer;
        let bytes = std::slice::from_raw_parts(
            credential.CredentialBlob,
            credential.CredentialBlobSize as usize,
        );
        String::from_utf8(bytes.to_vec()).map_err(|error| format!("decode credential: {error}"))
    };
    unsafe { CredFree(pointer.cast()) };
    result.map(Some)
}

#[cfg(target_os = "windows")]
fn platform_delete() -> Result<(), String> {
    use windows_sys::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};
    let target = wide(CREDENTIAL_TARGET);
    let ok = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
    if ok == 0 && std::io::Error::last_os_error().raw_os_error() != Some(1168) {
        return Err(format!(
            "delete Windows Credential Manager entry failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn platform_save(value: &str) -> Result<(), String> {
    let status = std::process::Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-a",
            "ZeroBox",
            "-s",
            CREDENTIAL_TARGET,
            "-w",
            value,
        ])
        .status()
        .map_err(|error| format!("launch macOS Keychain: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("write macOS Keychain entry failed".to_string())
    }
}

#[cfg(target_os = "macos")]
fn platform_load() -> Result<Option<String>, String> {
    let output = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            "ZeroBox",
            "-s",
            CREDENTIAL_TARGET,
            "-w",
        ])
        .output()
        .map_err(|error| format!("launch macOS Keychain: {error}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(
        String::from_utf8_lossy(&output.stdout).trim().to_string(),
    ))
}

#[cfg(target_os = "macos")]
fn platform_delete() -> Result<(), String> {
    let _ = std::process::Command::new("security")
        .args([
            "delete-generic-password",
            "-a",
            "ZeroBox",
            "-s",
            CREDENTIAL_TARGET,
        ])
        .status();
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
fn platform_save(value: &str) -> Result<(), String> {
    use std::io::Write;
    let mut child = std::process::Command::new("secret-tool")
        .args([
            "store",
            "--label=ZeroAgent device credential",
            "service",
            CREDENTIAL_TARGET,
            "account",
            "ZeroBox",
        ])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("launch Secret Service: {error}"))?;
    child
        .stdin
        .as_mut()
        .ok_or("Secret Service stdin unavailable")?
        .write_all(value.as_bytes())
        .map_err(|error| error.to_string())?;
    if child.wait().map_err(|error| error.to_string())?.success() {
        Ok(())
    } else {
        Err("write Secret Service entry failed".to_string())
    }
}

#[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
fn platform_load() -> Result<Option<String>, String> {
    let output = std::process::Command::new("secret-tool")
        .args(["lookup", "service", CREDENTIAL_TARGET, "account", "ZeroBox"])
        .output()
        .map_err(|error| format!("launch Secret Service: {error}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!value.is_empty()).then_some(value))
}

#[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
fn platform_delete() -> Result<(), String> {
    let _ = std::process::Command::new("secret-tool")
        .args(["clear", "service", CREDENTIAL_TARGET, "account", "ZeroBox"])
        .status();
    Ok(())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn platform_save(_value: &str) -> Result<(), String> {
    Err("device credential vault is unavailable on the mobile web wrapper".to_string())
}
#[cfg(any(target_os = "android", target_os = "ios"))]
fn platform_load() -> Result<Option<String>, String> {
    Ok(None)
}
#[cfg(any(target_os = "android", target_os = "ios"))]
fn platform_delete() -> Result<(), String> {
    Ok(())
}
