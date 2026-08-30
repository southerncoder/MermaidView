@echo off
echo Starting server...
.\target\release\mermaid-view-server.exe . --port 9001 --no-browser > server.log 2>&1 &

timeout /t 3 /nobreak > nul

echo.
echo Server started. Try opening: http://localhost:9001
echo.
echo If you still get "connection refused", run this next:
netsh advfirewall firewall show rule name=all | findstr mermaid
echo.
pause
