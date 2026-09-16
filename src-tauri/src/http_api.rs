use crate::{
    emit_companion_event, emit_http_action, emit_http_say, import_local_pet, ActionPayload,
    AppState, CompanionEventPayload, LocalImportPayload, SayPayload, ShutdownDecision,
    SHUTDOWN_ENDPOINT,
};
use serde::Serialize;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    thread,
    time::Duration,
};
use tauri::AppHandle;

/// How long the accepted response is given to flush before the process leaves.
const SHUTDOWN_FLUSH_MS: u64 = 250;

struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
    authorization: Option<String>,
}

pub fn start_http_api(app: AppHandle, state: AppState) {
    thread::spawn(move || {
        let config = state.api_bind_config();
        let addr = format!("{}:{}", config.listen_address, config.port);
        let listener = match TcpListener::bind((config.listen_address.as_str(), config.port)) {
            Ok(listener) => listener,
            Err(error) => {
                state.mark_api_error(format!("Failed to bind {addr}: {error}"));
                return;
            }
        };

        if let Ok(local_addr) = listener.local_addr() {
            state.mark_api_listening(local_addr.ip().to_string(), local_addr.port());
        }

        for stream in listener.incoming() {
            match stream {
                Ok(stream) => handle_stream(stream, &app, &state),
                Err(error) => state.mark_api_error(format!("HTTP API connection failed: {error}")),
            }
        }
    });
}

fn handle_stream(mut stream: TcpStream, app: &AppHandle, state: &AppState) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let request = match read_request(&stream) {
        Ok(request) => request,
        Err(error) => {
            let _ = write_json(
                &mut stream,
                400,
                &serde_json::json!({ "ok": false, "error": error }),
            );
            return;
        }
    };

    if request.method == "OPTIONS" {
        let _ = write_empty(&mut stream, 204);
        return;
    }

    if request.method == "GET" {
        if let Some(id) = request
            .path
            .strip_prefix("/api/pets/")
            .and_then(|path| path.strip_suffix("/spritesheet"))
        {
            let _ = match state.imported_pet_spritesheet_path(id) {
                Some(path) => write_file(&mut stream, &path, "image/webp"),
                None => write_json(
                    &mut stream,
                    404,
                    &serde_json::json!({ "ok": false, "error": "pet spritesheet not found" }),
                ),
            };
            return;
        }

        // Live2D 模型资源（MVP-14）：模型不入包，改由这里按需提供。
        // 路径校验与目录归属都在 AppState 里，这一层只负责选内容类型。
        if let Some(relative) = request.path.strip_prefix("/live2d/models/") {
            let _ = match state.live2d_asset_path(relative) {
                Some(path) => write_file(&mut stream, &path, model_content_type(&path)),
                None => write_json(
                    &mut stream,
                    404,
                    &serde_json::json!({ "ok": false, "error": "live2d asset not found" }),
                ),
            };
            return;
        }
    }

    let result = route_request(request, app, state);
    let _ = match result {
        Ok(value) => write_json(&mut stream, 200, &value),
        Err((status, error)) => write_json(
            &mut stream,
            status,
            &serde_json::json!({ "ok": false, "error": error }),
        ),
    };
}

fn read_request(stream: &TcpStream) -> Result<Request, String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|error| error.to_string())?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| "missing HTTP method".to_string())?
        .to_string();
    let path = parts
        .next()
        .ok_or_else(|| "missing HTTP path".to_string())?
        .split('?')
        .next()
        .unwrap_or("/")
        .to_string();

    let mut content_length = 0usize;
    let mut authorization: Option<String> = None;
    loop {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        // Header names are case-insensitive; the value is only ever compared, never logged.
        let (name, value) = match trimmed.split_once(':') {
            Some((name, value)) => (name.trim().to_ascii_lowercase(), value.trim().to_string()),
            None => continue,
        };
        match name.as_str() {
            "content-length" => content_length = value.parse::<usize>().unwrap_or(0),
            "authorization" => authorization = Some(value),
            _ => {}
        }
    }

    let mut body = vec![0_u8; content_length.min(64 * 1024)];
    if !body.is_empty() {
        reader
            .read_exact(&mut body)
            .map_err(|error| error.to_string())?;
    }

    Ok(Request {
        method,
        path,
        body,
        authorization,
    })
}

/// Extracts the credential from `Authorization: Bearer <token>`.
/// The scheme is mandatory: a bare token in the header is rejected.
fn bearer_token(header: Option<&str>) -> Option<String> {
    let value = header?.trim();
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    (!token.is_empty()).then(|| token.to_string())
}

fn schedule_shutdown(app: AppHandle) {
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(SHUTDOWN_FLUSH_MS));
        app.exit(0);
    });
}

fn route_request(
    request: Request,
    app: &AppHandle,
    state: &AppState,
) -> Result<serde_json::Value, (u16, String)> {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/api/status") => serde_json::to_value(state.snapshot())
            .map_err(|error| (500, format!("failed to serialize status: {error}"))),
        ("POST", "/api/action") => {
            let payload = parse_body::<ActionPayload>(&request.body)?;
            if payload.animation_id.trim().is_empty() {
                return Err((400, "animationId is required".to_string()));
            }
            emit_http_action(app, state, payload);
            serde_json::to_value(state.snapshot())
                .map_err(|error| (500, format!("failed to serialize status: {error}")))
        }
        ("POST", "/api/say") => {
            let mut payload = parse_body::<SayPayload>(&request.body)?;
            payload.text = payload.text.trim().chars().take(512).collect();
            emit_http_say(app, state, payload);
            serde_json::to_value(state.snapshot())
                .map_err(|error| (500, format!("failed to serialize status: {error}")))
        }
        ("POST", "/api/event") => {
            let payload = parse_body::<CompanionEventPayload>(&request.body)?;
            emit_companion_event(app, state, payload);
            serde_json::to_value(state.snapshot())
                .map_err(|error| (500, format!("failed to serialize status: {error}")))
        }
        ("POST", "/api/import/local") => {
            let payload = parse_body::<LocalImportPayload>(&request.body)?;
            let snapshot = import_local_pet(app, state, payload).map_err(|error| (400, error))?;
            serde_json::to_value(snapshot)
                .map_err(|error| (500, format!("failed to serialize status: {error}")))
        }
        ("POST", SHUTDOWN_ENDPOINT) => {
            let presented = bearer_token(request.authorization.as_deref());
            match state.begin_shutdown(presented.as_deref()) {
                ShutdownDecision::Accepted => {
                    schedule_shutdown(app.clone());
                    Ok(serde_json::json!({
                        "ok": true,
                        "shuttingDown": true,
                        "endpoint": SHUTDOWN_ENDPOINT,
                    }))
                }
                // 401: the caller presented nothing, or the wrong credential.
                ShutdownDecision::TokenRequired => Err((401, "exit token required".to_string())),
                ShutdownDecision::TokenInvalid => Err((401, "exit token rejected".to_string())),
                // 403: this instance has no exit token at all, so nobody may exit it.
                ShutdownDecision::NotAvailable(reason) => Err((403, reason)),
                ShutdownDecision::AlreadyInProgress => {
                    Err((503, "shutdown already in progress".to_string()))
                }
            }
        }
        _ => Err((404, "route not found".to_string())),
    }
}

fn parse_body<T>(body: &[u8]) -> Result<T, (u16, String)>
where
    T: for<'de> serde::Deserialize<'de>,
{
    serde_json::from_slice(body).map_err(|error| (400, format!("invalid JSON: {error}")))
}

fn write_empty(stream: &mut TcpStream, status: u16) -> std::io::Result<()> {
    let headers = format!(
    "HTTP/1.1 {} {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: content-type\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    status,
    reason(status),
  );
    stream.write_all(headers.as_bytes())
}

fn write_json<T>(stream: &mut TcpStream, status: u16, value: &T) -> std::io::Result<()>
where
    T: Serialize,
{
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
    let headers = format!(
    "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: content-type\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
    status,
    reason(status),
    body.len(),
  );
    stream.write_all(headers.as_bytes())?;
    stream.write_all(&body)
}

/// 模型资源只有三类：json（manifest / motion / expression / physics）、png（贴图）
/// 与 moc3（二进制模型）。其它扩展名按二进制流给，不做猜测。
fn model_content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("json") => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn write_file(
    stream: &mut TcpStream,
    path: &std::path::Path,
    content_type: &str,
) -> std::io::Result<()> {
    let body = fs::read(path)?;
    let headers = format!(
    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: content-type\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
    body.len(),
  );
    stream.write_all(headers.as_bytes())?;
    stream.write_all(&body)
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "OK",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_the_bearer_scheme_for_the_exit_credential() {
        assert_eq!(bearer_token(Some("Bearer abc")).as_deref(), Some("abc"));
        assert_eq!(bearer_token(Some("bearer abc")).as_deref(), Some("abc"));
        assert_eq!(bearer_token(Some("  Bearer   abc  ")).as_deref(), Some("abc"));
        // A bare token or another scheme is not a credential.
        assert_eq!(bearer_token(Some("abc")), None);
        assert_eq!(bearer_token(Some("Basic abc")), None);
        assert_eq!(bearer_token(Some("Bearer   ")), None);
        assert_eq!(bearer_token(None), None);
    }

    #[test]
    fn maps_shutdown_decisions_to_distinct_statuses() {
        assert_eq!(reason(401), "Unauthorized");
        assert_eq!(reason(403), "Forbidden");
        assert_eq!(reason(503), "Service Unavailable");
    }

    #[test]
    fn serves_model_assets_with_types_the_engine_can_use() {
        // 贴图给 image/png，manifest/motion/expression 给 json，moc3 给二进制流。
        assert_eq!(
            model_content_type(Path::new("hiyori/Hiyori.2048/texture_00.png")),
            "image/png"
        );
        assert_eq!(
            model_content_type(Path::new("hiyori/Hiyori.model3.json")),
            "application/json; charset=utf-8"
        );
        assert_eq!(
            model_content_type(Path::new("hiyori/Hiyori.moc3")),
            "application/octet-stream"
        );
        // 扩展名大小写不敏感；没有扩展名时不猜。
        assert_eq!(model_content_type(Path::new("a/TEXTURE.PNG")), "image/png");
        assert_eq!(
            model_content_type(Path::new("a/no-extension")),
            "application/octet-stream"
        );
    }
}
