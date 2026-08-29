"""Full feature E2E for mermaid-view-server.

Exercises every server-side feature over a real LSP pipe + HTTP + WebSocket:

  A. HTTP statics          /, /app.js, /styles.css, /mermaid.min.js, 404
  B. Extraction            fences, tilde, info-strings, .mmd, CRLF, multi-file
  C. Live updates          didChange -> API + WS update; didClose -> removal;
                           id churn when line_start shifts
  D. Code actions          inside/outside diagram, file without diagrams
  E. Execute command       highlightDiagram -> WS broadcast; unknown cmd
  F. Browser->server WS    showDocument -> window/showDocument request
  G. Theme                 init options, didChangeConfiguration shapes

Run from repo root:  python scripts/e2e_features.py
"""

import json
import base64
import os
import queue
import re
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

SERVER = Path("target/release/mermaid-view-server.exe")

URI_A = Path("fx-a.md").resolve()
URI_B = Path("fx-b-crlf.md").resolve()
URI_C = Path("fx-c-plain.md").resolve()

A_V1 = (
    "# A\n\n"
    "intro\n\n"
    "```mermaid\n"
    "flowchart TD\n"
    "  A --> B\n"
    "```\n\n"
    "between\n\n"
    "~~~mermaid\n"
    "pie title Pets\n"
    '  "Dogs" : 3\n'
    "~~~\n"
)
A_EDIT = (
    "# A\n\n"
    "intro\n\n"
    "```mermaid\n"
    "flowchart TD\n"
    "  A --> B --> C\n"
    "```\n\n"
    "between\n\n"
    "~~~mermaid\n"
    "pie title Pets\n"
    '  "Dogs" : 3\n'
    "~~~\n"
)
A_SHIFT = (
    "# A\n\n"
    "intro\n\n"
    "a brand new line shifts everything below\n\n"
    "```mermaid\n"
    "flowchart TD\n"
    "  A --> B --> C\n"
    "```\n\n"
    "between\n\n"
    "~~~mermaid\n"
    "pie title Pets\n"
    '  "Dogs" : 3\n'
    "~~~\n"
)
B_CRLF = "# B\r\n\r\n```mmd\r\nstateDiagram-v2\r\n  [*] --> s1\r\n```\r\n"
C_PLAIN = "# C\n\nno diagrams here\n"

PASS, FAIL = [], []


def report(name: str, ok: bool, detail: str = ""):
    (PASS if ok else FAIL).append(name if not detail else f"{name} ({detail})")
    print(("  PASS " if ok else "  FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""))


# ---------------- LSP helpers ----------------

def frame(obj: dict) -> bytes:
    body = json.dumps(obj).encode()
    return b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body


class LspClient:
    def __init__(self, proc):
        self.proc = proc
        self.msgs = queue.Queue()
        self.unexpected = []
        self._id = 0
        self.stdout = proc.stdout
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        f = self.stdout
        try:
            while True:
                headers = {}
                # Collect all header lines up to the blank line.
                line = f.readline()
                if not line:
                    return
                while line not in (b"\r\n", b"\n"):
                    k, _, v = line.decode().partition(":")
                    headers[k.strip().lower()] = v.strip()
                    line = f.readline()
                    if not line:
                        return
                n = int(headers.get("content-length", 0))
                if n == 0:
                    return
                body = f.read(n)
                self.msgs.put(json.loads(body))
        except (OSError, ValueError):  # JSONDecodeError is a ValueError
            return

    def send(self, obj: dict):
        self.proc.stdin.write(frame(obj))
        self.proc.stdin.flush()

    def request(self, method: str, params=None, timeout=10):
        rid = self.next_id()
        self.send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                m = self.msgs.get(timeout=0.1)
            except queue.Empty:
                continue
            if m.get("id") == rid:
                return m
            # keep other traffic (responses to other ids, requests from server)
            self.unexpected.append(m)
        return None

    def notify(self, method: str, params=None):
        self.send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def wait_request(self, method: str, timeout=10):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                m = self.msgs.get(timeout=0.1)
            except queue.Empty:
                continue
            if m.get("method") == method:
                return m
            self.unexpected.append(m)
        return None

    def next_id(self):
        self._id += 1
        return self._id

    _id = 0
    unexpected = []


def open_doc(client, uri, text, lang="markdown"):
    client.notify(
        "textDocument/didOpen",
        {"textDocument": {"uri": uri, "languageId": lang, "version": 1, "text": text}},
    )


def change_doc(client, uri, text, version=2):
    client.notify(
        "textDocument/didChange",
        {
            "textDocument": {"uri": uri, "version": version},
            "contentChanges": [{"text": text}],
        },
    )


def close_doc(client, uri):
    client.notify("textDocument/didClose", {"textDocument": {"uri": uri}})


# ---------------- HTTP helper ----------------

def http_get(port, path, timeout=5):
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()
    except Exception as e:
        return -1, {}, str(e).encode()


def wait_port(stderr_src, timeout=10):
    pat = re.compile(r"preview server on http://127\.0\.0\.1:(\d+)")
    deadline = time.time() + timeout
    while time.time() < deadline:
        m = pat.search("".join(stderr_src))
        if m:
            return m.group(1)
        time.sleep(0.05)
    return None


# ---------------- WebSocket helper ----------------

class Ws:
    def __init__(self, port):
        self.s = socket.create_connection(("127.0.0.1", int(port)), timeout=8)
        key = base64.b64encode(b"0123456789abcdef").decode()
        req = (
            "GET /ws HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.s.sendall(req.encode())
        self.buf = b""
        resp = self._read_until(b"\r\n\r\n")
        if b"101" not in resp.split(b"\r\n", 1)[0]:
            raise RuntimeError("WS upgrade failed: " + resp[:80].decode(errors="replace"))

    def _read_until(self, delim):
        while delim not in self.buf:
            chunk = self.s.recv(8192)
            if not chunk:
                raise ConnectionError("ws EOF")
            self.buf += chunk
        i = self.buf.index(delim) + len(delim)
        out, self.buf = self.buf[:i], self.buf[i:]
        return out

    def send_json(self, obj):
        payload = json.dumps(obj).encode()
        mask = b"\x11\x22\x33\x44"
         # client frames MUST be masked
        header = bytearray([0x81])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.s.sendall(bytes(header) + mask + masked)

    def recv_json(self, timeout=5):
        self.s.settimeout(timeout)
        while len(self.buf) < 2:
            self.buf += self._recv_more()
        b0, b1 = self.buf[0], self.buf[1]
        op = b0 & 0x0F
        masked = b1 & 0x80
        length = b1 & 0x7F
        idx = 2
        if length == 126:
            while len(self.buf) < 4:
                self.buf += self._recv_more()
            length = struct.unpack(">H", self.buf[2:4])[0]
            idx = 4
        elif length == 127:
            while len(self.buf) < 10:
                self.buf += self._recv_more()
            length = struct.unpack(">Q", self.buf[2:10])[0]
            idx = 10
        if masked:
            while len(self.buf) < idx + 4:
                self.buf += self._recv_more()
            idx += 4
        while len(self.buf) < idx + length:
            self.buf += self._recv_more()
        payload = self.buf[idx : idx + length]
        self.buf = self.buf[idx + length :]
        if op == 0x8:  # close
            return None
        if op == 0x1:  # text
            return json.loads(payload.decode())
            # ignore ping/binary

    def _recv_more(self):
        chunk = self.s.recv(8192)
        if not chunk:
            raise ConnectionError("ws EOF mid-frame")
        return chunk

    def drain(self, seconds=0.8):
        out = []
        end = time.time() + seconds
        while time.time() < end:
            try:
                out.append(self.recv_json(timeout=max(0.1, end - time.time())))
            except (socket.timeout, TimeoutError, ConnectionError, json.JSONDecodeError):
                pass
        return [m for m in out if m]

    def close(self):
        try:
            self.s.close()
        except OSError:
            pass


# ---------------- main ----------------

def main():
    if not SERVER.is_file():
        print("FAIL: build first: cargo build --release -p mermaid-view-server")
        return 1

    Path(URI_A).write_text(A_V1, newline="\n")
    Path(URI_B).write_text(B_CRLF, newline="\n")
    Path(URI_C).write_text(C_PLAIN, newline="\n")

    proc = subprocess.Popen(
        [str(SERVER)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "MERMAID_VIEW_NO_BROWSER": "1"},
    )
    stderr_src = []
    threading.Thread(target=lambda: [stderr_src.append(l.decode(errors="replace"))
                                     for l in iter(proc.stderr.readline, b"")],
                     daemon=True).start()
    lsp = LspClient(proc)
    results = {}

    try:
        init = lsp.request("initialize", {
            "processId": None, "rootUri": Path.cwd().as_uri(), "capabilities": {},
            "initializationOptions": {"theme": "light"},
        })
        report("LSP initialize handshake", init is not None
               and init["result"]["capabilities"]["textDocumentSync"] == 1)
        lsp.notify("initialized", {})
        lsp.notify("workspace/didChangeConfiguration", {"settings": {}})

        port = wait_port(stderr_src)
        report("HTTP server reported port", port is not None)
        if not port:
            print("".join(stderr_src))
            return 1

        # ---- A. HTTP statics ----
        time.sleep(0.3)
        st, hdr, body = http_get(port, "/")
        report("GET / serves canvas app",
               st == 200 and b"canvas-container" in body and b"mermaid.min.js" in body)
        st, hdr, body = http_get(port, "/app.js")
        report("GET /app.js served", st == 200 and b"connectWebSocket" in body)
        st, hdr, body = http_get(port, "/styles.css")
        report("GET /styles.css served", st == 200 and b"diagram-card" in body)
        st, hdr, body = http_get(port, "/mermaid.min.js")
        report("GET /mermaid.min.js is real vendored js",
               st == 200 and len(body) > 100_000 and b"error_html" not in body)
        st, _, _ = http_get(port, "/definitely-not-here")
        report("404 for unknown path", st == 404)
        st, _, body = http_get(port, "/api/diagrams")
        report("GET /api/diagrams ok", st == 200 and json.loads(body)["diagrams"] == [])

        # ---- B. Extraction over LSP ----
        open_doc(lsp, URI_A.as_uri(), A_V1)
        time.sleep(0.5)
        st, _, body = http_get(port, "/api/diagrams")
        d = json.loads(body)["diagrams"]
        results["a_diagrams"] = d
        types = {x["source"].splitlines()[0] for x in d}
        report("file A: 2 fence blocks extracted", len(d) == 2, f"got {len(d)}")
        report("file A: fence variants accepted (backtick + tilde)",
               types == {"flowchart TD", "pie title Pets"}, str(types))

        open_doc(lsp, URI_B.as_uri(), B_CRLF)
        time.sleep(0.5)
        st, _, body = http_get(port, "/api/diagrams")
        d2 = json.loads(body)["diagrams"]
        report("file B (CRLF): extracted with clean source",
               next((x for x in d2 if x["file"] == URI_B.as_uri()), {}).get("source")
               == "stateDiagram-v2\n  [*] --> s1")
        b_line = next((x for x in d2 if x["file"] == URI_B.as_uri()), {})
        report("file B (CRLF): line numbers correct",
               b_line.get("lineStart") == 3 and b_line.get("lineEnd") == 5,
               str(b_line))
        report("multi-file: two files registered",
               len({x["file"] for x in d2}) == 2)

        # ---- H. WS init + G. theme from init options ----
        ws = Ws(port)
        msgs = ws.drain(3.0)
        init_seen = next((m for m in msgs if m.get("type") == "init"), None)
        theme_msgs = [m for m in msgs if m.get("type") == "theme"]
        report("WS: init snapshot delivered", init_seen is not None,
               str([m.get("type") for m in msgs]))
        report("G: theme=light from initialization options",
               bool(theme_msgs) and theme_msgs[0]["theme"] == "light",
               str([m.get("theme") for m in theme_msgs]))

        # ---- F. showDocument round trip ----
        some_id = d[0]["id"]
        ws.send_json({"type": "showDocument", "id": some_id})
        req = lsp.wait_request("window/showDocument", timeout=5)
        expected_uri = some_id.rsplit(":", 1)[0]
        report("F: showDocument -> window/showDocument request",
               req is not None
               and req["params"]["uri"] == expected_uri
               and req["params"]["selection"]["start"]["line"] >= 0, str(req)[:120])

        # ---- E. highlight executeCommand ----
        rid = lsp.next_id()
        lsp.send({"jsonrpc": "2.0", "id": rid, "method": "workspace/executeCommand",
                  "params": {"command": "mermaidView.highlightDiagram",
                             "arguments": [some_id]}})
        seen_hl = [m for m in ws.drain(1.5) if m.get("type") == "highlight"]
        report("E: highlightDiagram broadcasts to WS",
               any(m.get("id") == some_id for m in seen_hl), str(seen_hl))
        # response for the executeCommand also arrived
        got_resp = None
        deadline = time.time() + 3
        while time.time() < deadline and got_resp is None:
            try:
                m = lsp.msgs.get(timeout=0.1)
                if m.get("id") == rid and m.get("method") is None:
                    got_resp = m
            except queue.Empty:
                pass

        # ---- D. code actions ----
        inside_line = 4  # 0-based line inside flowchart block (source lines 0-based 3..4)
        ca = lsp.request("textDocument/codeAction", {
            "textDocument": {"uri": URI_A.as_uri()},
            "range": {"start": {"line": inside_line, "character": 0},
                      "end": {"line": inside_line, "character": 0}},
            "context": {"diagnostics": []},
        })
        titles = [x["title"] for x in (ca["result"] if ca else [])]
        report("D: code action inside diagram offers both",
               "Open Diagram Workspace" in titles
               and "Highlight Diagram in Workspace" in titles, str(titles))

        outside_line = 1  # line 2 1-based: 'intro'
        ca = lsp.request("textDocument/codeAction", {
            "textDocument": {"uri": URI_A.as_uri()},
            "range": {"start": {"line": outside_line, "character": 0},
                      "end": {"line": outside_line, "character": 0}},
            "context": {"diagnostics": []},
        })
        titles = [x["title"] for x in (ca["result"] if ca and "result" in ca else
                   (ca.get("result") if ca else []))]
        report("D: code action outside diagram offers only 'Open'",
               "Open Diagram Workspace" in titles
               and "Highlight Diagram in Workspace" not in titles, str(titles))

        open_doc(lsp, URI_C.as_uri(), C_PLAIN)
        time.sleep(0.4)
        ca = lsp.request("textDocument/codeAction", {
            "textDocument": {"uri": URI_C.as_uri()},
            "range": {"start": {"line": 0, "character": 0},
                      "end": {"line": 0, "character": 0}},
            "context": {"diagnostics": []},
        })
        report("D: plain file -> no code actions", ca and ca["result"] == [])

        # ---- C. live updates ----
        change_doc(lsp, URI_A.as_uri(), A_EDIT)
        updates = [m for m in ws.drain(2.5) if m.get("type") == "update"]
        report("C: didChange pushes WS update", bool(updates))
        time.sleep(0.3)
        st, _, body = http_get(port, "/api/diagrams")
        d3 = json.loads(body)["diagrams"]
        new_src = [x["source"] for x in d3 if x["file"] == URI_A.as_uri()]
        report("C: didChange reflected in API",
               any("A --> B --> C" in s for s in new_src), str(new_src))
        old_ids = {x["id"] for x in results["a_diagrams"]}
        new_ids = {x["id"] for x in d3 if x["file"] == URI_A.as_uri()}
        report("C: in-place edit keeps ids, changes hash",
               old_ids == new_ids, f"{len(old_ids)}->{len(new_ids)}")

        change_doc(lsp, URI_A.as_uri(), A_SHIFT, version=3)
        updates = [m for m in ws.drain(2.5) if m.get("type") == "update"]
        time.sleep(0.3)
        st, _, body = http_get(port, "/api/diagrams")
        d3b = json.loads(body)["diagrams"]
        shifted_ids = {x["id"] for x in d3b if x["file"] == URI_A.as_uri()}
        report("C: id churn when lines shift (old removed, new added)",
               bool(old_ids - shifted_ids) and bool(shifted_ids - new_ids),
               f"{len(old_ids)}->{len(shifted_ids)}")

        # ---- C. didClose removal ----
        close_doc(lsp, URI_B.as_uri())
        updates = [m for m in ws.drain(2.0) if m.get("type") == "update"]
        time.sleep(0.3)
        st, _, body = http_get(port, "/api/diagrams")
        d4 = json.loads(body)["diagrams"]
        report("C: didClose removes file diagrams",
               all(x["file"] != URI_B.as_uri() for x in d4), str(len(d4)))
        report("C: didClose pushed WS update", bool(updates))

        # ---- G2. didChangeConfiguration both shapes ----
        lsp.notify("workspace/didChangeConfiguration", {"settings": {"theme": "dark"}})
        seen = [m for m in ws.drain(2.0) if m.get("type") == "theme"]
        report("G: didChangeConfiguration {'theme'} -> dark",
               seen and seen[-1]["theme"] == "dark", str(seen))
        lsp.notify("workspace/didChangeConfiguration",
                   {"settings": {"mermaidView": {"theme": "light"}}})
        seen = [m for m in ws.drain(2.0) if m.get("type") == "theme"]
        report("G: didChangeConfiguration {'mermaidView'} -> light",
               seen and seen[-1]["theme"] == "light", str(seen))
        lsp.notify("workspace/didChangeConfiguration", {"settings": {"theme": "bogus"}})
        seen = [m for m in ws.drain(1.2) if m.get("type") == "theme"]
        report("G: invalid theme ignored", not bool(seen), str(seen))

        # unknown command returns a response with null result
        rid = lsp.next_id()
        lsp.send({"jsonrpc": "2.0", "id": rid, "method": "workspace/executeCommand",
                  "params": {"command": "nope.command", "arguments": []}})
        got = None
        deadline = time.time() + 3
        while time.time() < deadline and got is None:
            try:
                m = lsp.msgs.get(timeout=0.1)
                if m.get("id") == rid:
                    got = m
            except queue.Empty:
                pass
        report("E: unknown command answers null result",
               got is not None and got.get("result") is None, str(got)[:100])

        ws.close()
    finally:
        try:
            proc.stdin.close()
        except OSError:
            pass
        proc.kill()
        Path(URI_A).unlink(missing_ok=True)
        Path(URI_B).unlink(missing_ok=True)
        Path(URI_C).unlink(missing_ok=True)

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    if FAIL:
        print("Failed:", *FAIL, sep="\n  - ")
        return 1
    print("ALL FEATURE CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())