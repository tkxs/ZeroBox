#![cfg(mobile)]

use std::{
    collections::{BTreeMap, HashMap},
    sync::Mutex,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use reqwest::{header, Client, Method};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    http::{header as ws_header, HeaderValue},
    protocol::Message,
};

const SESSION_COOKIE: &str = "zerobox_session";
const MAX_CACHE_ENTRIES: usize = 96;

#[derive(Default)]
struct MobileGatewaySession {
    origin: String,
    session_id: String,
    user_id: Option<i64>,
    cache: BTreeMap<String, MobileGatewayResponse>,
}

#[derive(Deserialize, Serialize)]
struct PersistedMobileGatewaySession {
    origin: String,
    session_id: String,
    user_id: Option<i64>,
    cache: BTreeMap<String, MobileGatewayResponse>,
}

#[derive(Default)]
struct MobileGatewaySockets {
    senders: HashMap<String, mpsc::UnboundedSender<Message>>,
}

pub struct MobileGatewayState {
    client: Client,
    session: Mutex<MobileGatewaySession>,
    sockets: Mutex<MobileGatewaySockets>,
}

impl Default for MobileGatewayState {
    fn default() -> Self {
        Self {
            client: Client::new(),
            session: Mutex::new(MobileGatewaySession::default()),
            sockets: Mutex::new(MobileGatewaySockets::default()),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileGatewaySocketConnect {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub protocols: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileGatewaySocketSend {
    pub id: String,
    pub data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileGatewaySocketEvent {
    id: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileGatewayRequest {
    pub path: String,
    pub method: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub body: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileGatewayResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: String,
    pub cached: bool,
}

fn normalize_origin(value: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(value.trim()).map_err(|_| "Gateway URL is invalid")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Gateway URL must use HTTP or HTTPS".to_string());
    }
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn cache_key(request: &MobileGatewayRequest) -> String {
    format!("{} {}", request.method.to_ascii_uppercase(), request.path)
}

fn request_url(origin: &str, path: &str) -> Result<reqwest::Url, String> {
    if !path.starts_with('/') || path.starts_with("//") {
        return Err("Only Gateway-relative paths are allowed".to_string());
    }
    reqwest::Url::parse(&format!("{origin}{path}"))
        .map_err(|_| "Gateway request URL is invalid".to_string())
}

fn socket_url(origin: &str, path: &str) -> Result<reqwest::Url, String> {
    let mut url = request_url(origin, path)?;
    match url.scheme() {
        "http" => {
            url.set_scheme("ws")
                .map_err(|_| "Gateway WebSocket URL is invalid")?;
        }
        "https" => {
            url.set_scheme("wss")
                .map_err(|_| "Gateway WebSocket URL is invalid")?;
        }
        _ => return Err("Gateway WebSocket URL is invalid".to_string()),
    }
    Ok(url)
}

fn emit_socket_event(app: &tauri::AppHandle, event: MobileGatewaySocketEvent) {
    let _ = app.emit("mobile-gateway-socket", event);
}

fn capture_session(values: &[String], state: &mut MobileGatewaySession) {
    for value in values {
        let Some((name, rest)) = value.split_once('=') else {
            continue;
        };
        if name.trim() != SESSION_COOKIE {
            continue;
        }
        let session_id = rest.split(';').next().unwrap_or_default().trim();
        if session_id.is_empty() {
            state.session_id.clear();
        } else {
            state.session_id = session_id.to_string();
        }
    }
}

fn capture_authenticated_user(path: &str, body: &str, state: &mut MobileGatewaySession) {
    if !path.starts_with("/api/auth/") {
        return;
    }
    let user_id = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("user")?.get("id")?.as_i64());
    let Some(user_id) = user_id else {
        return;
    };
    if state.user_id != Some(user_id) {
        state.cache.clear();
    }
    state.user_id = Some(user_id);
}

fn persist_session(session: &MobileGatewaySession) -> Result<(), String> {
    let persisted = PersistedMobileGatewaySession {
        origin: session.origin.clone(),
        session_id: session.session_id.clone(),
        user_id: session.user_id,
        cache: session.cache.clone(),
    };
    let data = serde_json::to_vec(&persisted)
        .map_err(|error| format!("serialize encrypted mobile state: {error}"))?;
    super::mobile_secure_store::save(&data)
}

#[tauri::command]
pub fn mobile_gateway_bootstrap(state: tauri::State<'_, MobileGatewayState>) -> Result<(), String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| "mobile gateway state is unavailable")?;
    if session.origin.is_empty() {
        if let Some(data) = super::mobile_secure_store::load()? {
            let persisted: PersistedMobileGatewaySession = serde_json::from_slice(&data)
                .map_err(|error| format!("parse encrypted mobile state: {error}"))?;
            session.origin = normalize_origin(&persisted.origin)?;
            session.session_id = persisted.session_id;
            session.user_id = persisted.user_id;
            session.cache = persisted.cache;
        }
    }
    if session.origin.is_empty() {
        if let Ok(origin) = std::env::var("ZEROAGENT_MOBILE_GATEWAY_ORIGIN") {
            if !origin.trim().is_empty() {
                session.origin = normalize_origin(&origin)?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn mobile_gateway_origin(
    state: tauri::State<'_, MobileGatewayState>,
) -> Result<String, String> {
    Ok(state
        .session
        .lock()
        .map_err(|_| "mobile gateway state is unavailable")?
        .origin
        .clone())
}

#[tauri::command]
pub fn mobile_gateway_configure(
    origin: String,
    state: tauri::State<'_, MobileGatewayState>,
) -> Result<String, String> {
    let origin = normalize_origin(&origin)?;
    let mut session = state
        .session
        .lock()
        .map_err(|_| "mobile gateway state is unavailable")?;
    let changed = session.origin != origin;
    if changed {
        session.origin = origin.clone();
        session.session_id.clear();
        session.user_id = None;
        session.cache.clear();
        super::mobile_secure_store::clear()?;
    }
    drop(session);
    if changed {
        let mut sockets = state
            .sockets
            .lock()
            .map_err(|_| "mobile Gateway sockets are unavailable")?;
        for sender in sockets.senders.drain().map(|(_, sender)| sender) {
            let _ = sender.send(Message::Close(None));
        }
    }
    Ok(origin)
}

#[tauri::command]
pub fn mobile_gateway_logout(state: tauri::State<'_, MobileGatewayState>) -> Result<(), String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| "mobile gateway state is unavailable")?;
    session.session_id.clear();
    session.user_id = None;
    session.cache.clear();
    super::mobile_secure_store::clear()?;
    let mut sockets = state
        .sockets
        .lock()
        .map_err(|_| "mobile Gateway sockets are unavailable")?;
    for sender in sockets.senders.drain().map(|(_, sender)| sender) {
        let _ = sender.send(Message::Close(None));
    }
    Ok(())
}

#[tauri::command]
pub async fn mobile_gateway_socket_connect(
    request: MobileGatewaySocketConnect,
    state: tauri::State<'_, MobileGatewayState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let id = request.id.trim().to_string();
    if id.is_empty() {
        return Err("Gateway WebSocket id is required".to_string());
    }
    let (origin, session_id) = {
        let session = state
            .session
            .lock()
            .map_err(|_| "mobile gateway state is unavailable")?;
        if session.origin.is_empty() {
            return Err("Configure the Gateway URL before connecting".to_string());
        }
        if session.session_id.is_empty() {
            return Err("Account login is required".to_string());
        }
        (session.origin.clone(), session.session_id.clone())
    };
    let socket_url = socket_url(&origin, &request.path)?;
    let mut handshake = socket_url
        .as_str()
        .into_client_request()
        .map_err(|error| format!("build Gateway WebSocket request: {error}"))?;
    handshake.headers_mut().insert(
        ws_header::COOKIE,
        HeaderValue::from_str(&format!("{SESSION_COOKIE}={session_id}"))
            .map_err(|_| "Gateway session is invalid".to_string())?,
    );
    if !request.protocols.is_empty() {
        let protocols = request
            .protocols
            .iter()
            .map(|item| item.trim())
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>()
            .join(", ");
        if !protocols.is_empty() {
            handshake.headers_mut().insert(
                ws_header::SEC_WEBSOCKET_PROTOCOL,
                HeaderValue::from_str(&protocols)
                    .map_err(|_| "Gateway WebSocket protocol is invalid".to_string())?,
            );
        }
    }
    let (socket, _) = tokio_tungstenite::connect_async(handshake)
        .await
        .map_err(|error| format!("connect Gateway WebSocket: {error}"))?;
    let (mut sink, mut stream) = socket.split();
    let (sender, mut receiver) = mpsc::unbounded_channel::<Message>();
    {
        let mut sockets = state
            .sockets
            .lock()
            .map_err(|_| "mobile Gateway sockets are unavailable")?;
        if let Some(previous) = sockets.senders.insert(id.clone(), sender) {
            let _ = previous.send(Message::Close(None));
        }
    }

    let write_id = id.clone();
    let write_app = app.clone();
    tokio::spawn(async move {
        while let Some(message) = receiver.recv().await {
            if sink.send(message).await.is_err() {
                emit_socket_event(
                    &write_app,
                    MobileGatewaySocketEvent {
                        id: write_id.clone(),
                        kind: "error",
                        data: None,
                        message: Some("Gateway WebSocket write failed".to_string()),
                    },
                );
                break;
            }
        }
    });

    let read_id = id.clone();
    let read_app = app.clone();
    tokio::spawn(async move {
        emit_socket_event(
            &read_app,
            MobileGatewaySocketEvent {
                id: read_id.clone(),
                kind: "open",
                data: None,
                message: None,
            },
        );
        while let Some(message) = stream.next().await {
            match message {
                Ok(Message::Binary(data)) => emit_socket_event(
                    &read_app,
                    MobileGatewaySocketEvent {
                        id: read_id.clone(),
                        kind: "message",
                        data: Some(BASE64.encode(data)),
                        message: None,
                    },
                ),
                Ok(Message::Close(_)) => break,
                Ok(_) => {}
                Err(error) => {
                    emit_socket_event(
                        &read_app,
                        MobileGatewaySocketEvent {
                            id: read_id.clone(),
                            kind: "error",
                            data: None,
                            message: Some(format!("Gateway WebSocket read failed: {error}")),
                        },
                    );
                    break;
                }
            }
        }
        emit_socket_event(
            &read_app,
            MobileGatewaySocketEvent {
                id: read_id,
                kind: "close",
                data: None,
                message: None,
            },
        );
    });
    Ok(())
}

#[tauri::command]
pub fn mobile_gateway_socket_send(
    request: MobileGatewaySocketSend,
    state: tauri::State<'_, MobileGatewayState>,
) -> Result<(), String> {
    let data = BASE64
        .decode(request.data)
        .map_err(|_| "Gateway WebSocket payload is invalid".to_string())?;
    let sockets = state
        .sockets
        .lock()
        .map_err(|_| "mobile Gateway sockets are unavailable")?;
    let sender = sockets
        .senders
        .get(request.id.trim())
        .ok_or_else(|| "Gateway WebSocket is not connected".to_string())?;
    sender
        .send(Message::Binary(data.into()))
        .map_err(|_| "Gateway WebSocket is closed".to_string())
}

#[tauri::command]
pub fn mobile_gateway_socket_close(
    id: String,
    state: tauri::State<'_, MobileGatewayState>,
) -> Result<(), String> {
    let sender = state
        .sockets
        .lock()
        .map_err(|_| "mobile Gateway sockets are unavailable")?
        .senders
        .remove(id.trim());
    if let Some(sender) = sender {
        let _ = sender.send(Message::Close(None));
    }
    Ok(())
}

#[tauri::command]
pub async fn mobile_gateway_request(
    request: MobileGatewayRequest,
    state: tauri::State<'_, MobileGatewayState>,
) -> Result<MobileGatewayResponse, String> {
    let method = Method::from_bytes(request.method.as_bytes())
        .map_err(|_| "Gateway request method is invalid")?;
    let key = cache_key(&request);
    let (origin, session_id) = {
        let session = state
            .session
            .lock()
            .map_err(|_| "mobile gateway state is unavailable")?;
        if session.origin.is_empty() {
            return Err("Configure the Gateway URL before signing in".to_string());
        }
        (session.origin.clone(), session.session_id.clone())
    };
    let url = request_url(&origin, &request.path)?;
    let mut builder = state.client.request(method.clone(), url);
    for (name, value) in &request.headers {
        if let (Ok(name), Ok(value)) = (
            header::HeaderName::from_bytes(name.as_bytes()),
            header::HeaderValue::from_str(value),
        ) {
            builder = builder.header(name, value);
        }
    }
    if !session_id.is_empty() {
        builder = builder.header(header::COOKIE, format!("{SESSION_COOKIE}={session_id}"));
    }
    if !request.body.is_empty() {
        builder = builder.body(request.body.clone());
    }
    let response = match builder.send().await {
        Ok(response) => response,
        Err(error) => {
            let session = state
                .session
                .lock()
                .map_err(|_| "mobile gateway state is unavailable")?;
            if method == Method::GET {
                if let Some(cached) = session.cache.get(&key) {
                    let mut cached = cached.clone();
                    cached.cached = true;
                    return Ok(cached);
                }
            }
            return Err(format!("Gateway request failed: {error}"));
        }
    };
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect();
    let set_cookies = response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok().map(str::to_string))
        .collect::<Vec<_>>();
    let body = response
        .text()
        .await
        .map_err(|error| format!("read Gateway response: {error}"))?;
    let mut session = state
        .session
        .lock()
        .map_err(|_| "mobile gateway state is unavailable")?;
    capture_session(&set_cookies, &mut session);
    if (200..300).contains(&status) {
        capture_authenticated_user(&request.path, &body, &mut session);
    }
    let result = MobileGatewayResponse {
        status,
        headers,
        body,
        cached: false,
    };
    if method == Method::GET && (200..300).contains(&status) && session.user_id.is_some() {
        if session.cache.len() >= MAX_CACHE_ENTRIES {
            session.cache.pop_first();
        }
        session.cache.insert(key, result.clone());
    }
    persist_session(&session)?;
    Ok(result)
}
