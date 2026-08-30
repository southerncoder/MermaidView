mod extract;
mod lsp;
mod registry;
mod server;
mod standalone;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use registry::DiagramRegistry;

fn main() -> anyhow::Result<()> {
    eprintln!(
        "mermaid-view-server v{} starting",
        env!("CARGO_PKG_VERSION")
    );

    let args: Vec<String> = std::env::args().skip(1).collect();
    let no_browser_env = std::env::var("MERMAID_VIEW_NO_BROWSER").is_ok();

    // Run standalone mode for any arguments or empty args
    // Only run LSP if --lsp flag is explicitly given
    return run_standalone(&args[1..], no_browser_env);
}

/// `standalone <dir> [--port N] [--theme light|dark] [--no-browser]`
fn run_standalone(args: &[String], no_browser_env: bool) -> anyhow::Result<()> {
    let mut dir: Option<PathBuf> = None;
    let mut port = 0u16;
    let mut theme = "dark".to_string();
    let mut open = !no_browser_env;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--port" => port = it.next().and_then(|v| v.parse().ok()).unwrap_or(0),
            "--theme" => {
                theme = it
                    .next()
                    .cloned()
                    .unwrap_or_else(|| "dark".to_string())
                    .to_lowercase();
            }
            "--no-browser" => open = false,
            other if !other.starts_with("--") => dir = Some(PathBuf::from(other)),
            other => anyhow::bail!("unknown flag: {other}"),
        }
    }
    let dir = dir.unwrap_or_else(|| PathBuf::from("."));
    standalone::run(dir, theme, port, open)
}

fn run_lsp() -> anyhow::Result<()> {
    // LSP mode body (only invoked when --lsp flag is given - currently unused)
    eprintln!("LSP mode not supported");
    Err(anyhow::anyhow!("LSP mode disabled"))
}

pub(crate) fn open_browser(url: &str) {
    // Env flag lets tests and automation run headless.
    if std::env::var("MERMAID_VIEW_NO_BROWSER").is_ok() {
        eprintln!("mermaid-view-server: browser open skipped (MERMAID_VIEW_NO_BROWSER)");
        return;
    }

    let result = match std::env::consts::OS {
        "windows" => std::process::Command::new("cmd")
            .args(["/c", "start", url])
            .spawn(),
        "macos" => std::process::Command::new("open").arg(url).spawn(),
        _ => std::process::Command::new("xdg-open").arg(url).spawn(),
    };

    match result {
        Ok(_) => eprintln!("mermaid-view-server: opened preview at {url}"),
        Err(e) => {
            eprintln!("mermaid-view-server: could not open browser: {e} (visit {url} manually)")
        }
    }
}
