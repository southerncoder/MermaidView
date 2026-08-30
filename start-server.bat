@echo off
cd /d "%~dp0"
echo Starting MermaidView server on port 8082...
.\target\release\mermaid-view-server.exe . --port 8082 --no-browser
pause
