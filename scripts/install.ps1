# Install MermaidView as a Zed dev extension on Windows.
# Run from the repository root in PowerShell:
#   .\scripts\install.ps1
# Then in Zed run: Extensions: Install Dev Extension and select this repository.

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$zedDir = Join-Path $env:LOCALAPPDATA "Zed"
$workDir = Join-Path $zedDir "extensions\work\mermaid-view"

Write-Host "Building mermaid-view-server (release)..." -ForegroundColor Cyan
& cargo build --release -p mermaid-view-server
if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }

$binary = "mermaid-view-server.exe"
$sourceBinary = Join-Path $repoRoot "target\release\$binary"
if (-not (Test-Path $sourceBinary)) {
    throw "Server binary not found at $sourceBinary"
}

# Copy the binary next to the extension manifest so the dev-extension copy picks it up,
# and also into Zed's work directory for the current installation.
Copy-Item $sourceBinary (Join-Path $repoRoot $binary) -Force
Write-Host "Copied server binary to repository root." -ForegroundColor Green

if (-not (Test-Path $workDir)) {
    New-Item -ItemType Directory -Force -Path $workDir | Out-Null
}
Copy-Item $sourceBinary (Join-Path $workDir $binary) -Force
Write-Host "Copied server binary to $workDir" -ForegroundColor Green

# If the work directory already has the extension files, also refresh the binary there.
$workWeb = Join-Path $workDir "web"
$repoWeb = Join-Path $repoRoot "web"
if (Test-Path $workWeb) {
    Copy-Item $repoWeb\* $workWeb -Recurse -Force
    Write-Host "Refreshed web assets in $workDir." -ForegroundColor Green
}

Write-Host ""
Write-Host "Installation complete!" -ForegroundColor Green
Write-Host "Next steps:"
Write-Host "  1. In Zed, run: Extensions: Install Dev Extension"
Write-Host "  2. Select: $repoRoot"
Write-Host "  3. Open a Markdown or .mmd file with mermaid blocks"
Write-Host "  4. Use the code action (Ctrl+.) or the browser should open automatically"
