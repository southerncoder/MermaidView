use std::collections::HashMap;

use lsp_server::{Connection, Message, Notification, Request, RequestId, Response};
use lsp_types::{
    CodeAction, CodeActionKind, CodeActionOrCommand, CodeActionParams, CodeActionResponse, Command,
    DidChangeConfigurationParams, DidChangeTextDocumentParams, DidCloseTextDocumentParams,
    DidOpenTextDocumentParams, ExecuteCommandOptions, ExecuteCommandParams, InitializeParams,
    InitializeResult, ServerCapabilities, ServerInfo, TextDocumentSyncKind,
};

use crate::extract::{extract_blocks_accurate, extract_mmd_file};
use crate::registry::DiagramRegistry;
use crate::server::{SharedActiveFile, SharedTheme};
use std::sync::{Arc, Mutex};

/// Main LSP handler state.
pub struct LspState {
    registry: Arc<Mutex<DiagramRegistry>>,
    documents: HashMap<String, String>,
    connection: Connection,
    server_url: Option<String>,
    theme: String,
    theme_handle: SharedTheme,
    active_file: SharedActiveFile,
}

impl LspState {
    pub fn new(
        connection: Connection,
        registry: Arc<Mutex<DiagramRegistry>>,
        theme_handle: SharedTheme,
        active_file: SharedActiveFile,
    ) -> Self {
        Self {
            registry,
            documents: HashMap::new(),
            connection,
            server_url: None,
            theme: "dark".to_string(),
            theme_handle,
            active_file,
        }
    }

    pub fn set_server_url(&mut self, url: String) {
        self.server_url = Some(url);
    }

    pub fn set_theme(&mut self, theme: String) {
        // Only act on valid themes, and only broadcast on actual change.
        if (theme == "light" || theme == "dark") && self.theme != theme {
            self.theme = theme.clone();
            *self.theme_handle.lock().unwrap() = theme.clone();
            self.broadcast_to_browser(serde_json::json!({
                "type": "theme",
                "theme": theme,
            }));
        }
    }

    /// Run the LSP main loop. Performs initialization first.
    pub fn main_loop(&mut self) -> anyhow::Result<()> {
        eprintln!("mermaid-view-server: LSP initializing");

        let (init_id, init_params) = self.connection.initialize_start()?;
        let initialize_params: InitializeParams = serde_json::from_value(init_params)?;

        // Theme can arrive via initialization options (set through
        // "lsp.mermaid-view.settings" in Zed) before any didChangeConfiguration.
        if let Some(theme) = initialize_params
            .initialization_options
            .as_ref()
            .and_then(|v| theme_setting(v))
            .filter(|t| !t.is_empty())
        {
            self.set_theme(theme);
        }

        let server_info = ServerInfo {
            name: "MermaidView".to_string(),
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
        };

        let capabilities = ServerCapabilities {
            text_document_sync: Some(lsp_types::TextDocumentSyncCapability::Kind(
                TextDocumentSyncKind::FULL,
            )),
            code_action_provider: Some(lsp_types::CodeActionProviderCapability::Simple(true)),
            execute_command_provider: Some(ExecuteCommandOptions {
                commands: vec![
                    "mermaidView.openWorkspace".to_string(),
                    "mermaidView.highlightDiagram".to_string(),
                ],
                work_done_progress_options: Default::default(),
            }),
            ..Default::default()
        };

        let result = InitializeResult {
            capabilities,
            server_info: Some(server_info),
        };

        self.connection
            .initialize_finish(init_id, serde_json::to_value(&result)?)?;

        eprintln!("mermaid-view-server: LSP initialized");
        self.loop_messages()
    }

    fn loop_messages(&mut self) -> anyhow::Result<()> {
        eprintln!("mermaid-view-server: main loop started");

        while let Ok(msg) = self.connection.receiver.recv() {
            match msg {
                Message::Request(req) => {
                    if self.connection.handle_shutdown(&req)? {
                        return Ok(());
                    }
                    self.handle_request(req);
                }
                Message::Notification(notif) => {
                    self.handle_notification(notif);
                }
                Message::Response(resp) => {
                    eprintln!("mermaid-view-server: response: {:?}", resp.id);
                }
            }
        }

        eprintln!("mermaid-view-server: main loop ended");
        Ok(())
    }

    fn handle_request(&mut self, req: Request) {
        match req.method.as_str() {
            "textDocument/codeAction" => {
                let params: CodeActionParams = match serde_json::from_value(req.params.clone()) {
                    Ok(p) => p,
                    Err(e) => {
                        eprintln!("mermaid-view-server: parse error: {e}");
                        return;
                    }
                };
                let result = self.code_actions(&params);
                let resp = Response {
                    id: req.id,
                    result: Some(serde_json::to_value(result).unwrap()),
                    error: None,
                };
                let _ = self.connection.sender.send(Message::Response(resp));
            }
            "workspace/executeCommand" => {
                let params: ExecuteCommandParams = match serde_json::from_value(req.params.clone())
                {
                    Ok(p) => p,
                    Err(e) => {
                        eprintln!("mermaid-view-server: parse error: {e}");
                        return;
                    }
                };
                self.execute_command(&params, req.id);
            }
            other => {
                eprintln!("mermaid-view-server: unhandled request: {other}");
            }
        }
    }

    fn handle_notification(&mut self, notif: Notification) {
        match notif.method.as_str() {
            "textDocument/didOpen" => {
                let params: DidOpenTextDocumentParams = match serde_json::from_value(notif.params) {
                    Ok(p) => p,
                    Err(e) => {
                        eprintln!("mermaid-view-server: parse error: {e}");
                        return;
                    }
                };
                self.document_opened(
                    &params.text_document.uri.to_string(),
                    &params.text_document.text,
                );
            }
            "textDocument/didChange" => {
                let params: DidChangeTextDocumentParams = match serde_json::from_value(notif.params)
                {
                    Ok(p) => p,
                    Err(e) => {
                        eprintln!("mermaid-view-server: parse error: {e}");
                        return;
                    }
                };
                let file_uri = params.text_document.uri.to_string();
                if let Some(change) = params.content_changes.first() {
                    // LSP full-sync: replace entire content with the latest change
                    let full_text = change.text.clone();
                    if let Some(content) = self.documents.get_mut(&file_uri) {
                        *content = full_text.clone();
                    } else {
                        self.documents.insert(file_uri.clone(), full_text);
                    }
                    self.document_changed(&file_uri);
                }
            }
            "workspace/didChangeConfiguration" => {
                let params: DidChangeConfigurationParams =
                    match serde_json::from_value(notif.params) {
                        Ok(p) => p,
                        Err(e) => {
                            eprintln!("mermaid-view-server: parse error: {e}");
                            return;
                        }
                    };
                self.configuration_changed(params);
            }
            "textDocument/didClose" => {
                let params: DidCloseTextDocumentParams = match serde_json::from_value(notif.params)
                {
                    Ok(p) => p,
                    Err(e) => {
                        eprintln!("mermaid-view-server: parse error: {e}");
                        return;
                    }
                };
                self.document_closed(&params.text_document.uri.to_string());
            }
            other => {
                eprintln!("mermaid-view-server: unhandled: {other}");
            }
        }
    }

    fn document_opened(&mut self, file_uri: &str, content: &str) {
        if !is_markdown(file_uri) && !is_mermaid(file_uri) {
            return;
        }
        self.documents
            .insert(file_uri.to_string(), content.to_string());
        self.set_active_file(file_uri);
        self.update_diagrams(file_uri);
    }

    fn document_changed(&mut self, file_uri: &str) {
        if !is_markdown(file_uri) && !is_mermaid(file_uri) {
            return;
        }
        // Ensure the file exists in our map even if a didChange arrives before didOpen
        if !self.documents.contains_key(file_uri) {
            return;
        }
        self.set_active_file(file_uri);
        self.update_diagrams(file_uri);
    }

    /// Remember the most recently opened/edited file (proxy for "current
    /// editor" — Zed does not emit a focus notification we can use) and
    /// tell connected browsers.
    fn set_active_file(&mut self, file_uri: &str) {
        *self.active_file.lock().unwrap() = Some(file_uri.to_string());
        self.broadcast_to_browser(serde_json::json!({
            "type": "activeFile",
            "file": file_uri,
        }));
    }

    fn document_closed(&mut self, file_uri: &str) {
        self.documents.remove(file_uri);
        let mut reg = self.registry.lock().unwrap();
        reg.remove_file(file_uri);
    }

    fn update_diagrams(&mut self, file_uri: &str) {
        let content = match self.documents.get(file_uri) {
            Some(c) => c.clone(),
            None => return,
        };

        // Bare .mmd files are one diagram per file; markdown uses fence matching.
        let blocks: Vec<(String, u32, u32)> = if is_mermaid(file_uri) {
            extract_mmd_file(&content)
                .map(|b| vec![(b.source, b.line_start, b.line_end)])
                .unwrap_or_default()
        } else {
            extract_blocks_accurate(&content)
                .into_iter()
                .map(|b| (b.source, b.line_start, b.line_end))
                .collect()
        };

        let mut reg = self.registry.lock().unwrap();
        reg.update_file(file_uri, blocks);
    }

    fn code_actions(&self, params: &CodeActionParams) -> CodeActionResponse {
        let file_uri = params.text_document.uri.to_string();
        if !is_markdown(&file_uri) && !is_mermaid(&file_uri) {
            return Vec::new();
        }

        let line = params.range.start.line + 1;
        let reg = self.registry.lock().unwrap();
        let diagrams = reg.diagrams_for_file(&file_uri);
        let has_diagrams = !diagrams.is_empty();
        let cursor_in_diagram = diagrams
            .iter()
            .any(|d| line >= d.line_start && line <= d.line_end);

        let mut actions = Vec::new();

        if has_diagrams {
            actions.push(CodeActionOrCommand::CodeAction(CodeAction {
                title: "Open Diagram Workspace".to_string(),
                kind: Some(CodeActionKind::REFACTOR),
                command: Some(Command {
                    title: "Open Diagram Workspace".to_string(),
                    command: "mermaidView.openWorkspace".to_string(),
                    arguments: Some(vec![serde_json::json!(self
                        .server_url
                        .as_deref()
                        .unwrap_or(""))]),
                }),
                ..Default::default()
            }));
        }

        if cursor_in_diagram {
            if let Some(diagram) = diagrams
                .iter()
                .find(|d| line >= d.line_start && line <= d.line_end)
            {
                actions.push(CodeActionOrCommand::CodeAction(CodeAction {
                    title: "Highlight Diagram in Workspace".to_string(),
                    kind: Some(CodeActionKind::REFACTOR),
                    command: Some(Command {
                        title: "Highlight Diagram in Workspace".to_string(),
                        command: "mermaidView.highlightDiagram".to_string(),
                        arguments: Some(vec![serde_json::json!(diagram.id.clone())]),
                    }),
                    ..Default::default()
                }));
            }
        }

        actions
    }

    fn configuration_changed(&mut self, params: DidChangeConfigurationParams) {
        // Accepts both shapes:
        //   { "theme": "light" }
        //   { "mermaidView": { "theme": "light" } }
        let settings = &params.settings;
        let new_theme = theme_setting(settings).unwrap_or_else(|| self.theme.clone());

        self.set_theme(new_theme);
    }

    fn broadcast_to_browser(&self, msg: serde_json::Value) {
        let payload = msg.to_string();
        let mut reg = self.registry.lock().unwrap();
        reg.notify_custom(payload);
    }

    fn execute_command(&mut self, params: &ExecuteCommandParams, id: RequestId) {
        let result = if params.command == "mermaidView.openWorkspace" {
            if let Some(url) = self.server_url.as_ref() {
                crate::open_browser(url);
            }
            Some(serde_json::Value::Null)
        } else if params.command == "mermaidView.highlightDiagram" {
            if let Some(arg) = params.arguments.first() {
                if let Some(id) = arg.as_str() {
                    self.broadcast_to_browser(serde_json::json!({
                        "type": "highlight",
                        "id": id,
                    }));
                }
            }
            Some(serde_json::Value::Null)
        } else {
            None
        };

        let resp = Response {
            id,
            result,
            error: None,
        };
        let _ = self.connection.sender.send(Message::Response(resp));
    }
}

fn is_markdown(uri: &str) -> bool {
    uri.ends_with(".md") || uri.ends_with(".markdown") || uri.ends_with(".mdx")
}

fn is_mermaid(uri: &str) -> bool {
    uri.ends_with(".mmd")
}

fn theme_setting(value: &serde_json::Value) -> Option<String> {
    let raw = value
        .get("mermaidView")
        .and_then(|v| v.get("theme"))
        .or_else(|| value.get("theme"))
        .and_then(|v| v.as_str())?;
    let lower = raw.to_lowercase();
    (lower == "light" || lower == "dark").then_some(lower)
}
