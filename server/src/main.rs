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

    if args.first().map(String::as_str) == Some("standalone") {
        return run_standalone(&args[1..], no_browser_env);
    }
    run_lsp()
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
            other => anyhow::bail!("unknown standalone flag: {other}"),
        }
    }
    let dir = dir.unwrap_or_else(|| PathBuf::from("."));
    standalone::run(dir, theme, port, open)
}

fn run_lsp() -> anyhow::Result<()> {
    // LSP mode body (invoked when no subcommand is given)
    {
        // LSP connection (stdin/stdout)
        let (connection, io_threads) = lsp_server::Connection::stdio();

        // Shared state
        let registry = Arc::new(Mutex::new(DiagramRegistry::new()));
        let theme: Arc<Mutex<String>> = Arc::new(Mutex::new("dark".to_string()));
        let active_file: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        // Start the preview server
        let mut preview = server::PreviewServer::new(
            Arc::clone(&registry),
            connection.sender.clone(),
            Arc::clone(&theme),
            Arc::clone(&active_file),
        );
        let port = preview.start()?;
        let url = format!("http://127.0.0.1:{port}");

        // Open the preview in the browser
        open_browser(&url);

        // Initialize LSP state with server URL and shared theme handle
        let mut lsp_state = lsp::LspState::new(connection, registry, theme, active_file);
        lsp_state.set_server_url(url);

        // Run the LSP main loop
        lsp_state.main_loop()?;

        // Clean up
        io_threads.join()?;
    }
    Ok(())
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
