use std::env;
use std::path::PathBuf;
use zed_extension_api::{
    self as zed, serde_json, settings::LspSettings, LanguageServerId, Result, Worktree,
};

const LANGUAGE_SERVER_ID: &str = "mermaid-view";

struct MermaidViewExtension {
    server_path: Option<String>,
}

impl zed::Extension for MermaidViewExtension {
    fn new() -> Self {
        Self { server_path: None }
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<zed::Command> {
        let server_path = self.resolve_server_path(worktree)?;
        Ok(zed::Command {
            command: server_path,
            args: vec![],
            env: Default::default(),
        })
    }

    fn language_server_workspace_configuration(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<serde_json::Value>> {
        LspSettings::for_worktree(LANGUAGE_SERVER_ID, worktree).map(|s| s.settings)
    }

    fn language_server_initialization_options(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<serde_json::Value>> {
        LspSettings::for_worktree(LANGUAGE_SERVER_ID, worktree).map(|s| s.settings)
    }
}

impl MermaidViewExtension {
    fn resolve_server_path(&mut self, worktree: &Worktree) -> Result<String> {
        if let Some(ref path) = self.server_path {
            return Ok(path.clone());
        }

        // 1. Explicit binary override via Zed settings:
        //    "lsp": { "mermaid-view": { "binary": { "path": "..." } } }
        if let Some(path) = LspSettings::for_worktree(LANGUAGE_SERVER_ID, worktree)
            .ok()
            .and_then(|s| s.binary)
            .and_then(|b| b.path)
            .filter(|p| PathBuf::from(p).is_file())
        {
            return self.finalize_path(PathBuf::from(path));
        }

        // 2. Environment override (host tooling only; not inherited inside WASM).
        if let Ok(path) = env::var("MERMAID_VIEW_SERVER_PATH") {
            let candidate = PathBuf::from(path);
            if candidate.is_file() {
                return self.finalize_path(candidate);
            }
        }

        // 3. Worktree PATH lookup.
        if let Some(path) = worktree.which("mermaid-view-server") {
            return self.finalize_path(PathBuf::from(path));
        }

        // 4. Local build / extension work dir paths. Inside Zed, the current
        //    directory is the extension's work dir, so the bundled binary lands
        //    at ./mermaid-view-server(.exe) next to ./web/.
        let binary = binary_name();
        let current_dir =
            env::current_dir().map_err(|e| format!("Failed to get current directory: {e}"))?;

        let candidates = vec![
            current_dir.join(&binary),
            current_dir.join("target").join("release").join(&binary),
            current_dir.join("target").join("debug").join(&binary),
            current_dir
                .join("server")
                .join("target")
                .join("release")
                .join(&binary),
            current_dir
                .join("server")
                .join("target")
                .join("debug")
                .join(&binary),
        ];

        if let Some(path) = candidates.into_iter().find(|p| p.is_file()) {
            return self.finalize_path(path);
        }

        Err(format!(
            "mermaid-view-server binary not found.\n\
             Build it with: cd server && cargo build --release\n\
             Or set \"lsp.mermaid-view.binary.path\" in your Zed settings."
        ))
    }

    fn finalize_path(&mut self, path: PathBuf) -> Result<String> {
        let resolved = path
            .canonicalize()
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();
        self.server_path = Some(resolved.clone());
        Ok(resolved)
    }
}

fn binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "mermaid-view-server.exe"
    } else {
        "mermaid-view-server"
    }
}

zed_extension_api::register_extension!(MermaidViewExtension);
