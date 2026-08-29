use std::env;
use std::path::PathBuf;
use zed_extension_api::{self as zed, LanguageServerId, Result};

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
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let server_path = self.resolve_server_path(worktree)?;
        Ok(zed::Command {
            command: server_path,
            args: vec![],
            env: Default::default(),
        })
    }
}

impl MermaidViewExtension {
    fn resolve_server_path(&mut self, worktree: &zed::Worktree) -> Result<String> {
        if let Some(ref path) = self.server_path {
            return Ok(path.clone());
        }

        // 1. Check MERMAID_VIEW_SERVER_PATH env var
        if let Ok(path) = env::var("MERMAID_VIEW_SERVER_PATH") {
            let candidate = PathBuf::from(&path);
            if candidate.is_file() {
                return self.finalize_path(candidate);
            }
        }

        // 2. Check worktree PATH
        if let Some(path) = worktree.which("mermaid-view-server") {
            return self.finalize_path(PathBuf::from(path));
        }

        // 3. Check local build paths
        let binary = binary_name();
        let extension_dir =
            env::current_dir().map_err(|e| format!("Failed to get current directory: {e}"))?;

        let candidates = vec![
            extension_dir.join(&binary),
            extension_dir.join("target").join("release").join(&binary),
            extension_dir.join("target").join("debug").join(&binary),
            extension_dir
                .join("server")
                .join("target")
                .join("release")
                .join(&binary),
            extension_dir
                .join("server")
                .join("target")
                .join("debug")
                .join(&binary),
        ];

        if let Some(path) = candidates.into_iter().find(|p| p.is_file()) {
            return self.finalize_path(path);
        }

        // 4. TODO: Download from GitHub releases
        Err(format!(
            "mermaid-view-server binary not found.\n\
             Build it with: cd server && cargo build --release\n\
             Or set MERMAID_VIEW_SERVER_PATH to its location."
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
