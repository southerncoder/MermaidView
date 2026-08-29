use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result};
use notify::Watcher;

use crate::extract::{extract_blocks_accurate, extract_mmd_file};
use crate::registry::DiagramRegistry;
use crate::server::{PreviewServer, SharedActiveFile, SharedTheme};

pub const WATCHED_EXTS: [&str; 4] = ["md", "markdown", "mdx", "mmd"];
const SCAN_SKIP_DIRS: [&str; 5] = [".git", "node_modules", "target", "dist", ".zed"];

/// Run the preview server WITHOUT an LSP client: recursively index all
/// markdown/mermaid files under `dir`, open the browser, and watch for
/// changes until killed.
pub fn run(dir: PathBuf, theme: String, port: u16, open: bool) -> Result<()> {
    let dir = dir
        .canonicalize()
        .with_context(|| format!("resolving directory {}", dir.display()))?;

    let registry = Arc::new(Mutex::new(DiagramRegistry::new()));
    let theme_handle: SharedTheme = Arc::new(Mutex::new(theme.clone()));
    let active: SharedActiveFile = Arc::new(Mutex::new(None));
    // No LSP client in standalone mode: browser->server messages that would
    // need to reach the editor (showDocument) are silently dropped.
    let (dummy_tx, _dummy_rx) = crossbeam_channel::unbounded::<lsp_server::Message>();

    let mut preview = PreviewServer::new(Arc::clone(&registry), dummy_tx, theme_handle, active);
    let bound_port = preview.start_on(port)?;
    let url = format!("http://127.0.0.1:{bound_port}");
    if open {
        crate::open_browser(&url);
    } else {
        eprintln!("mermaid-view-server: preview ready at {url} (browser open disabled)");
    }

    // Initial index
    let mut files = Vec::new();
    collect_files(&dir, &mut files);
    for file in &files {
        register_file(&registry, file);
    }
    eprintln!(
        "mermaid-view-server: indexed {} diagram file(s) under {}",
        files.len(),
        dir.display()
    );

    // Watch for changes (recursive). Events are debounced; each batch updates
    // the file whose content changed and re-scans for created/renamed files.
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = tx.send(event.paths);
            }
        })
        .context("failed to create filesystem watcher")?;
    watcher
        .watch(&dir, notify::RecursiveMode::Recursive)
        .with_context(|| format!("watching {}", dir.display()))?;

    loop {
        match rx.recv() {
            Ok(first_batch) => {
                let mut paths: HashSet<PathBuf> = HashSet::new();
                paths.extend(first_batch);
                // Debounce: editors save in bursts; wait for them to settle.
                let deadline = Instant::now() + Duration::from_millis(300);
                while Instant::now() < deadline {
                    match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                        Ok(batch) => paths.extend(batch),
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
                    }
                }

                let mut touched = 0u32;
                for path in &paths {
                    if !is_watched(path) {
                        continue;
                    }
                    if path.is_file() {
                        register_file(&registry, path);
                        touched += 1;
                    } else {
                        // Deleted or moved away
                        registry.lock().unwrap().remove_file(&path_to_uri(path));
                        touched += 1;
                    }
                }
                if touched > 0 {
                    eprintln!("mermaid-view-server: updated {touched} file(s)");
                }
            }
            Err(std::sync::mpsc::RecvError) => return Ok(()), // watcher dropped
        }
    }
}

/// Read the file and push its diagrams into the registry.
pub fn register_file(registry: &Arc<Mutex<DiagramRegistry>>, file: &Path) {
    let content = match std::fs::read_to_string(file) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("mermaid-view-server: skipping {}: {e}", file.display());
            return;
        }
    };
    let uri = path_to_uri(file);
    let diagrams: Vec<(String, u32, u32)> =
        if file.extension().and_then(|e| e.to_str()) == Some("mmd") {
            extract_mmd_file(&content)
                .map(|b| vec![(b.source, b.line_start, b.line_end)])
                .unwrap_or_default()
        } else {
            extract_blocks_accurate(&content)
                .into_iter()
                .map(|b| (b.source, b.line_start, b.line_end))
                .collect()
        };
    registry.lock().unwrap().update_file(&uri, diagrams);
}

fn is_watched(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| WATCHED_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Recursive directory scan for supported files, skipping VCS/build dirs.
fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => {
                if !SCAN_SKIP_DIRS.contains(&name.as_ref()) && !name.starts_with('.') {
                    collect_files(&path, out);
                }
            }
            Ok(_) => {
                if is_watched(&path) {
                    out.push(path);
                }
            }
            Err(_) => {}
        }
    }
}

/// WindowsPath -> file:///D:/... (uncoded scheme; matches LSP use).
pub fn path_to_uri(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if let Some(rest) = text.strip_prefix('/') {
        return format!("file:///{rest}");
    }
    format!("file:///{text}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_path_to_uri_windows() {
        let p = Path::new("D:\\Code\\x\\a.md");
        assert_eq!(path_to_uri(p), "file:///D:/Code/x/a.md");
    }

    #[test]
    fn test_path_to_uri_unix() {
        let p = Path::new("/home/u/a.md");
        assert_eq!(path_to_uri(p), "file:///home/u/a.md");
    }

    #[test]
    fn test_is_watched() {
        assert!(is_watched(Path::new("x.MD")));
        assert!(is_watched(Path::new("x.mmd")));
        assert!(!is_watched(Path::new("x.rs")));
        assert!(!is_watched(Path::new("README")));
    }
}
