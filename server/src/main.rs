mod extract;
mod lsp;
mod registry;
mod server;

use std::sync::{Arc, Mutex};

use registry::DiagramRegistry;

fn main() -> anyhow::Result<()> {
    eprintln!(
        "mermaid-view-server v{} starting",
        env!("CARGO_PKG_VERSION")
    );

    // LSP connection (stdin/stdout)
    let (connection, io_threads) = lsp_server::Connection::stdio();

    // Shared state
    let registry = Arc::new(Mutex::new(DiagramRegistry::new()));

    // Start the preview server
    let theme = "dark".to_string();
    let mut preview =
        server::PreviewServer::new(Arc::clone(&registry), connection.sender.clone(), theme);
    let port = preview.start()?;
    let url = format!("http://127.0.0.1:{port}");

    // Open the preview in the browser
    open_browser(&url);

    // Initialize LSP state with server URL and initial theme
    let mut lsp_state = lsp::LspState::new(connection, registry);
    lsp_state.set_server_url(url);
    lsp_state.set_theme("dark".to_string());

    // Run the LSP main loop
    lsp_state.main_loop()?;

    // Clean up
    io_threads.join()?;
    Ok(())
}

fn open_browser(url: &str) {
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
