"""E2E: drive mermaid-view-server as an LSP client and verify /api/diagrams.

Spawns the server on stdin/stdout pipes, performs the initialize handshake
(with theme in initialization_options), opens a markdown file containing two
mermaid blocks via didOpen, then fetches the diagram list from the HTTP API.

The server prints its assigned port to stderr, so stderr is read on a thread
and parsed. Run from the repo root with the release build present:

    python scripts/e2e_test.py
"""

import json
import re
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

SERVER = Path("target/release/mermaid-view-server.exe")

FILE_A = Path("e2e-fixture-a.md")
CONTENT_A = """# Fixture A

Intro text.

```mermaid
flowchart TD
  A[Start] --> B{OK?}
  B -- yes --> C[End]
  B -- no --> A
```

Trailing text.

```mermaid
sequenceDiagram
  Alice->>Bob: Hi
  Bob-->>Alice: Hello
```
"""

FILE_B = Path("e2e-fixture-b.md")
CONTENT_B = """# Fixture B

```mermaid
pie title Pets
  "Dogs" : 386
  "Cats" : 85
```
"""


def frame(obj: dict) -> bytes:
    body = json.dumps(obj).encode()
    return b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body


def read_stderr(pipe, sink):
    for line in iter(pipe.readline, b""):
        sink.append(line.decode(errors="replace"))
        if any("error" in l.lower() for l in sink[-1:]):
            pass


def main() -> int:
    if not SERVER.is_file():
        print(f"FAIL: {SERVER} missing. Run: cargo build --release -p mermaid-view-server")
        return 1

    FILE_A.write_text(CONTENT_A, newline="\n")
    FILE_B.write_text(CONTENT_B, newline="\n")

    proc = subprocess.Popen(
        [str(SERVER)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**__import__("os").environ, "MERMAID_VIEW_NO_BROWSER": "1"},
    )

    stderr_lines = []
    t = threading.Thread(target=read_stderr, args=(proc.stderr, stderr_lines), daemon=True)
    t.start()

    init = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "processId": None,
            "rootUri": Path.cwd().as_uri(),
            "capabilities": {},
            "initializationOptions": {"theme": "light"},
        },
    }

    initialized = {"jsonrpc": "2.0", "method": "initialized", "params": {}}

    results = {}
    try:
        proc.stdin.write(frame(init))
        proc.stdin.write(frame(initialized))
        uri_a = FILE_A.resolve().as_uri()
        uri_b = FILE_B.resolve().as_uri()
        for uri, text in ((uri_a, CONTENT_A), (uri_b, CONTENT_B)):
            proc.stdin.write(
                frame({
                    "jsonrpc": "2.0",
                    "method": "textDocument/didOpen",
                    "params": {
                        "textDocument": {
                            "uri": uri,
                            "languageId": "markdown",
                            "version": 1,
                            "text": text,
                        }
                    },
                })
            )
        proc.stdin.flush()

        # Wait for the HTTP server to come up (port number appears on stderr).
        port = None
        deadline = time.time() + 10
        while time.time() < deadline and port is None:
            joined = "".join(stderr_lines)
            m = re.search(r"preview server on http://127\.0\.0\.1:(\d+)", joined)
            port = m.group(1) if m else None
            time.sleep(0.05)

        if port is None:
            print("FAIL: server never reported its port")
            print("".join(stderr_lines))
            return 1

        time.sleep(1.0)  # let didOpen propagate

        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/diagrams", timeout=5) as resp:
            data = json.load(resp)

        results["count"] = len(data["diagrams"])
        results["files"] = {d["file"] for d in data["diagrams"]}
        results["lines_ok"] = all(
            d["lineStart"] >= 1 and d["lineEnd"] >= d["lineStart"] for d in data["diagrams"]
        )

        ws_ok = check_websocket(port)

        ok = (
            results["count"] == 3
            and len(results["files"]) == 2
            and results["lines_ok"]
            and ws_ok
        )
        print("diagrams:", results["count"], "files:", results["files"])
        print("websocket+theme:", "ok" if ws_ok else "FAIL")
        print("PASS" if ok else "FAIL")
        return 0 if ok else 1
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        proc.kill()
        FILE_A.unlink(missing_ok=True)
        FILE_B.unlink(missing_ok=True)


def check_websocket(port: str) -> bool:
    """Minimal WS client: connect, read the first JSON message, verify theme."""
    import base64
    import os
    import socket

    try:
        s = socket.create_connection(("127.0.0.1", int(port)), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET /ws HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        s.sendall(req.encode())
        s.settimeout(5)
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += s.recv(4096)
        if b"101" not in buf.split(b"\r\n", 1)[0]:
            s.close()
            return False
        # Read one WS frame (server sends text payload with small header).
        frame = s.recv(4096)
        if not frame:
            s.close()
            return False
        b0, b1 = frame[0], frame[1]
        payload_len = b1 & 0x7F
        offset = 2
        if payload_len == 126:
            payload_len = int.from_bytes(frame[2:4], "big")
            offset = 4
        payload = frame[offset : offset + payload_len]
        msg = json.loads(payload.decode())
        s.close()
        return msg.get("type") == "theme" and msg.get("theme") in ("light", "dark")
    except Exception as e:
        print("ws check error:", e)
        return False


if __name__ == "__main__":
    sys.exit(main())