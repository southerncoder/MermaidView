use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use crossbeam_channel::Sender;
use lsp_server::Message;

use crate::registry::DiagramRegistry;

/// Theme shared between the LSP handler (writer) and the WS upgrade path
/// (reader), so new browser connections get the current value.
pub type SharedTheme = Arc<Mutex<String>>;

/// HTTP server that serves the preview app and provides diagram data via REST
/// and WebSocket.
pub struct PreviewServer {
    pub port: u16,
    registry: Arc<Mutex<DiagramRegistry>>,
    base_dir: String,
    lsp_sender: Arc<Mutex<Sender<Message>>>,
    theme: SharedTheme,
}

impl PreviewServer {
    pub fn new(
        registry: Arc<Mutex<DiagramRegistry>>,
        lsp_sender: Sender<Message>,
        theme: SharedTheme,
    ) -> Self {
        Self {
            port: 0,
            registry,
            base_dir: find_web_dir(),
            lsp_sender: Arc::new(Mutex::new(lsp_sender)),
            theme,
        }
    }

    /// Start the server on a background thread. Returns the assigned port.
    pub fn start(&mut self) -> anyhow::Result<u16> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|e| anyhow::anyhow!("Failed to bind HTTP server: {e}"))?;

        let port = listener.local_addr()?.port();
        self.port = port;

        let registry = Arc::clone(&self.registry);
        let base_dir = self.base_dir.clone();
        let lsp_sender = Arc::clone(&self.lsp_sender);
        let theme = Arc::clone(&self.theme);
        let request_counter = AtomicU64::new(1);

        thread::spawn(move || {
            eprintln!(
                "mermaid-view-server: preview server on http://127.0.0.1:{port} (web dir: {base_dir})"
            );
            Self::serve(
                listener,
                registry,
                &base_dir,
                lsp_sender,
                request_counter,
                theme,
            );
        });

        Ok(port)
    }

    fn serve(
        listener: TcpListener,
        registry: Arc<Mutex<DiagramRegistry>>,
        base_dir: &str,
        lsp_sender: Arc<Mutex<Sender<Message>>>,
        request_counter: AtomicU64,
        theme: SharedTheme,
    ) {
        for stream in listener.incoming() {
            match stream {
                Ok(mut stream) => {
                    let registry = Arc::clone(&registry);
                    let base_dir = base_dir.to_string();
                    let lsp_sender = Arc::clone(&lsp_sender);
                    let counter = AtomicU64::new(request_counter.fetch_add(1, Ordering::SeqCst));
                    let theme = Arc::clone(&theme);
                    thread::spawn(move || {
                        if let Err(e) = Self::handle_connection(
                            &mut stream,
                            &registry,
                            &base_dir,
                            &lsp_sender,
                            &counter,
                            &theme,
                        ) {
                            eprintln!("mermaid-view-server: connection error: {e}");
                        }
                    });
                }
                Err(e) => eprintln!("mermaid-view-server: accept error: {e}"),
            }
        }
    }

    fn handle_connection(
        stream: &mut std::net::TcpStream,
        registry: &Arc<Mutex<DiagramRegistry>>,
        base_dir: &str,
        lsp_sender: &Arc<Mutex<Sender<Message>>>,
        request_counter: &AtomicU64,
        theme: &SharedTheme,
    ) -> anyhow::Result<()> {
        // Read the full HTTP request headers (up to the blank line)
        let mut buf = [0u8; 8192];
        let mut header_bytes = Vec::new();
        loop {
            let n = stream.read(&mut buf)?;
            if n == 0 {
                break;
            }
            header_bytes.extend_from_slice(&buf[..n]);
            if header_bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
            if header_bytes.len() >= 8192 {
                break;
            }
        }

        let request = String::from_utf8_lossy(&header_bytes);
        let first_line = request.lines().next().unwrap_or("");
        let mut parts = first_line.split_whitespace();
        let _method = parts.next().unwrap_or("GET");
        let path = parts.next().unwrap_or("/");

        // Check for WebSocket upgrade request
        let is_ws = request.to_ascii_lowercase().contains("upgrade: websocket")
            && request.to_ascii_lowercase().contains("connection: upgrade");

        if is_ws {
            Self::handle_ws_upgrade(
                stream,
                &request,
                registry,
                lsp_sender,
                request_counter,
                theme,
            );
            return Ok(());
        }

        let (status, content_type, body) = Self::handle_http_request(path, registry, base_dir);

        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(response.as_bytes())?;
        stream.write_all(body.as_bytes())?;
        stream.flush()?;
        Ok(())
    }

    fn handle_http_request(
        path: &str,
        registry: &Arc<Mutex<DiagramRegistry>>,
        base_dir: &str,
    ) -> (&'static str, &'static str, String) {
        let web_path = |file: &str| std::path::Path::new(base_dir).join(file);
        match path {
            "/" | "/index.html" => match std::fs::read_to_string(web_path("index.html")) {
                Ok(c) => ("200 OK", "text/html; charset=utf-8", c),
                Err(e) => (
                    "200 OK",
                    "text/html; charset=utf-8",
                    Self::error_html(&format!("web/index.html not found: {e}")),
                ),
            },
            "/app.js" => match std::fs::read_to_string(web_path("app.js")) {
                Ok(c) => ("200 OK", "application/javascript", c),
                Err(e) => (
                    "200 OK",
                    "text/html",
                    Self::error_html(&format!("web/app.js not found: {e}")),
                ),
            },
            "/styles.css" => match std::fs::read_to_string(web_path("styles.css")) {
                Ok(c) => ("200 OK", "text/css", c),
                Err(e) => (
                    "200 OK",
                    "text/html",
                    Self::error_html(&format!("web/styles.css not found: {e}")),
                ),
            },
            "/mermaid.min.js" => match std::fs::read_to_string(web_path("mermaid.min.js")) {
                Ok(c) => ("200 OK", "application/javascript", c),
                Err(_) => (
                    "200 OK",
                    "text/html",
                    Self::error_html(
                        "mermaid.js not vendored. Run: scripts/vendor.sh or download from cdn.jsdelivr.net",
                    ),
                ),
            },
            "/api/diagrams" => {
                let reg = registry.lock().unwrap();
                let diagrams: Vec<serde_json::Value> = reg
                    .all_diagrams()
                    .iter()
                    .map(|d| {
                        serde_json::json!({
                            "id": d.id,
                            "source": d.source,
                            "file": d.file,
                            "lineStart": d.line_start,
                            "lineEnd": d.line_end,
                            "contentHash": d.content_hash,
                        })
                    })
                    .collect();

                let body = serde_json::json!({ "diagrams": diagrams });
                (
                    "200 OK",
                    "application/json",
                    serde_json::to_string(&body).unwrap(),
                )
            }
            _ => (
                "404 Not Found",
                "text/html",
                format!("<h1>404: {} not found</h1>", path),
            ),
        }
    }

    fn handle_ws_upgrade(
        stream: &mut std::net::TcpStream,
        request: &str,
        registry: &Arc<Mutex<DiagramRegistry>>,
        lsp_sender: &Arc<Mutex<Sender<Message>>>,
        request_counter: &AtomicU64,
        theme: &SharedTheme,
    ) {
        // Extract Sec-WebSocket-Key
        let key = request
            .lines()
            .find_map(|line| {
                let lower = line.to_ascii_lowercase();
                if lower.starts_with("sec-websocket-key:") {
                    Some(line[18..].trim().to_string())
                } else {
                    None
                }
            })
            .unwrap_or_default();

        if key.is_empty() {
            eprintln!("mermaid-view-server: websocket upgrade missing key");
            return;
        }

        let accept = tungstenite::handshake::derive_accept_key(key.as_bytes());

        let response = format!(
            "HTTP/1.1 101 Switching Protocols\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Sec-WebSocket-Accept: {accept}\r\n\
             \r\n"
        );

        if let Err(e) = stream.write_all(response.as_bytes()) {
            eprintln!("mermaid-view-server: ws handshake write failed: {e}");
            return;
        }
        if let Err(e) = stream.flush() {
            eprintln!("mermaid-view-server: ws handshake flush failed: {e}");
            return;
        }

        // Create a tungstenite WebSocket from the raw socket now that handshake is complete.
        let stream_clone = match stream.try_clone() {
            Ok(s) => s,
            Err(e) => {
                eprintln!("mermaid-view-server: failed to clone stream: {e}");
                return;
            }
        };
        let mut ws = tungstenite::WebSocket::from_raw_socket(
            stream_clone,
            tungstenite::protocol::Role::Server,
            None,
        );
        // Use non-blocking reads so the loop can also forward updates
        let _ = ws.get_ref().set_nonblocking(true);

        // Subscribe to diagram changes
        let rx = {
            let mut reg = registry.lock().unwrap();
            reg.subscribe_json().1
        };

        // Send the CURRENT theme (may have been changed via didChangeConfiguration
        // or initialization options) right after init.
        let current_theme = theme.lock().unwrap().clone();
        if let Err(e) = ws.send(tungstenite::Message::Text(
            serde_json::json!({"type": "theme", "theme": current_theme})
                .to_string()
                .into(),
        )) {
            eprintln!("mermaid-view-server: ws theme send error: {e}");
        }

        let lsp_sender = Arc::clone(lsp_sender);
        let registry = Arc::clone(registry);
        let request_counter = AtomicU64::new(request_counter.load(Ordering::SeqCst));

        thread::spawn(move || {
            loop {
                // Forward any pending diagram updates before reading next message
                while let Ok(payload) = rx.try_recv() {
                    if let Err(e) = ws.send(tungstenite::Message::Text(payload.into())) {
                        eprintln!("mermaid-view-server: ws send error: {e}");
                        break;
                    }
                }

                // Check for incoming client messages without blocking forever
                match ws.read() {
                    Ok(msg) => {
                        if let tungstenite::Message::Text(text) = msg {
                            Self::handle_client_message(
                                &text,
                                &registry,
                                &lsp_sender,
                                &request_counter,
                            );
                        }
                    }
                    Err(tungstenite::Error::ConnectionClosed)
                    | Err(tungstenite::Error::AlreadyClosed) => break,
                    Err(tungstenite::Error::Io(ref e))
                        if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(e) => {
                        eprintln!("mermaid-view-server: ws read error: {e}");
                        break;
                    }
                }

                thread::sleep(std::time::Duration::from_millis(50));
            }

            // Drain remaining updates gracefully
            while let Ok(payload) = rx.try_recv() {
                let _ = ws.send(tungstenite::Message::Text(payload.into()));
            }
            let _ = ws.close(None);
            eprintln!("mermaid-view-server: websocket client disconnected");
        });
    }

    fn handle_client_message(
        text: &str,
        _registry: &Arc<Mutex<DiagramRegistry>>,
        lsp_sender: &Arc<Mutex<Sender<Message>>>,
        request_counter: &AtomicU64,
    ) {
        let Ok(value): Result<serde_json::Value, _> = serde_json::from_str(text) else {
            return;
        };

        if value.get("type").and_then(|v| v.as_str()) == Some("showDocument") {
            let Some(id) = value.get("id").and_then(|v| v.as_str()) else {
                return;
            };
            let Some((file, line)) = id.rsplit_once(':') else {
                return;
            };
            let Ok(line_start): Result<u32, _> = line.parse() else {
                return;
            };
            let line_start = line_start.saturating_sub(1);
            let line_end = line_start; // single-line selection; can be expanded later

            let params = serde_json::json!({
                "uri": file,
                "selection": {
                    "start": { "line": line_start, "character": 0 },
                    "end": { "line": line_end, "character": 0 }
                }
            });

            let req_id =
                lsp_server::RequestId::from(request_counter.fetch_add(1, Ordering::SeqCst) as i32);
            let req = lsp_server::Request {
                id: req_id,
                method: "window/showDocument".to_string(),
                params,
            };

            if let Err(e) = lsp_sender.lock().unwrap().send(Message::Request(req)) {
                eprintln!("mermaid-view-server: failed to send showDocument: {e}");
            }
        }
    }

    fn error_html(msg: &str) -> String {
        format!(
            r#"<!DOCTYPE html><html><head><style>body{{font-family:system-ui;background:#1e1e2e;color:#cdd6f4;display:flex;align-items:center;justify-content:center;height:100vh;}}</style></head><body><div style="text-align:center"><h1>MermaidView</h1><p style="color:#f38ba8">{msg}</p></div></body></html>"#,
            msg = msg
        )
    }
}

/// Find the web/ directory relative to the executable or workspace root.
fn find_web_dir() -> String {
    if std::path::Path::new("web").is_dir() {
        return "web".to_string();
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let web = parent.join("web");
            if web.is_dir() {
                return web.to_string_lossy().to_string();
            }
        }
    }
    "web".to_string()
}
