"""Standalone development server: drives mermaid-view-server like Zed would.

Creates a set of fixture markdown files covering many Mermaid diagram types,
spawns the release server binary, performs the LSP handshake, opens all
fixtures, and keeps the pipe alive so the browser canvas stays live.

Usage (from repo root, server release build present):

    python scripts/dev_server.py [--theme light|dark] [--port-file PATH]

The preview server browser tab opens automatically (MERMAID_VIEW_NO_BROWSER
is not set). Stop with Ctrl+C or by closing this process; the server exits
when stdin closes.

Fixture files live in dev-fixtures/ (gitignored) and are recreated on
each run, so edits in the browser never touch real files — edit THE FIXTURES
in an editor to see live didChange behavior (pass --watch to pick up changes).
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SERVER = REPO / "target" / "release" / "mermaid-view-server.exe"
FIXTURE_DIR = REPO / "dev-fixtures"

FIXTURES: dict[str, str] = {
    "01-flowcharts.md": """# Flowcharts

## Simple decision

```mermaid
flowchart TD
  A[Start] --> B{Deploy?}
  B -- yes --> C[Ship it]
  B -- no --> D[Fix bugs]
  D --> B
```

## Left-right pipeline

```mermaid
flowchart LR
  src[(Source)] --> lint[Lint]
  lint --> test[Tests]
  test --> pkg[Package]
  pkg --> rel{{Release}}
```

## Grouped subgraphs

```mermaid
flowchart TB
  subgraph Frontend
    UI(Svelte) ----> Store(Zustand)
  end
  subgraph Backend
    API(Rust) --> DB[(Postgres)]
  end
  Store <-.-> API
```
""",
    "02-sequence.md": """# Sequence diagrams

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant F as Frontend
  participant S as Server
  participant D as Database
  U->>F: Click "Save"
  F->>S: POST /diagram
  S->>D: INSERT
  D-->>S: ok
  S-->>F: 201 Created
  F-->>U: Toast "Saved"
```

```mermaid
sequenceDiagram
  loop Every 30s
    Client->>Server: heartbeat
    Server-->>Client: pong
  end
```
""",
    "03-class-state.md": """# Class + state

```mermaid
classDiagram
  class Diagram {
    +String source
    +u32 lineStart
    +render() SVG
  }
  class Canvas {
    +Vec~Diagram~ diagrams
    +fitAll()
  }
  Diagram "*" --o "1" Canvas
  Canvas <|-- Workspace
```

```mermaid
stateDiagram-v2
  [*] --> Editing
  Editing --> Rendering: didChange
  Rendering --> Editing: rendered
  Editing --> Error: invalid syntax
  Error --> Editing: fixed
  Editing --> [*]: closed
```
""",
    "04-er-gantt.md": """# ER + Gantt

```mermaid
erDiagram
  PROJECT ||--o{ FILE : contains
  FILE ||--|{ DIAGRAM : contains
  DIAGRAM }o--o{ TAG : tagged
  PROJECT {
    string name
    string path
  }
  DIAGRAM {
    string id
    int lineStart
  }
```

```mermaid
gantt
  title MermaidView roadmap
  dateFormat YYYY-MM-DD
  section Phase 3
  Theme sync      :done,    p3a, 2026-08-20, 3d
  Export          :done,    p3b, after p3a, 2d
  section Phase 4
  Card dragging   :active,  p4a, 2026-08-28, 4d
  Search          :p4b, after p4a, 2d
  Standalone CLI  :         p4c, after p4b, 5d
```
""",
    "05-pie-journey.md": """# Pie + journey

```mermaid
pie title Time spent on MermaidView
  "Server" : 35
  "Canvas" : 40
  "LSP" : 15
  "Docs" : 10
```

```mermaid
journey
  title A developer's day
  section Morning
    Make coffee: 5: Dev
    Open Zed: 3: Me
  section Afternoon
    Sketch diagrams: 8: Me
    Ship feature: 9: Me, Team
```
""",
    "06-git-mindmap.md": """# gitGraph + mindmap

```mermaid
gitGraph
  commit id: "init"
  branch feature/canvas
  commit id: "pan/zoom"
  commit id: "cards"
  checkout main
  merge feature/canvas id: "MVP"
  commit id: "polish"
```

```mermaid
mindmap
  root((MermaidView))
    Zed extension
      WASM shim
      LSP bridge
    Server
      Rust
        LSP protocol
        HTTP + WS
      Diagram registry
    Canvas
      Mermaid v11
      Pan/zoom
      Live updates
```
""",
    "07-quadrant-timeline.md": """# Quadrant + timeline

```mermaid
quadrantChart
  title Canvas feature tradeoffs
  x-axis Low reach --> High reach
  y-axis Low value --> High value
  quadrant-1 Ship next
  quadrant-2 Watch carefully
  quadrant-3 Maybe later
  quadrant-4 Nice to have
  Card drag: [0.85, 0.9]
  Search: [0.6, 0.8]
  Presentation: [0.4, 0.5]
  CLI mode: [0.7, 0.35]
```

```mermaid
timeline
  title MermaidView milestones
  section 2026-08
    Phase 1 : Zed extension
            : Rust server
    Phase 2 : Multi-diagram canvas
    Phase 3 : Theme sync
            : Export SVG/PNG
  section 2026-09
    Phase 4 : Card dragging
            : Search
```
""",
    "08-sampler.mmd": """flowchart LR
  mm[.mmd file] -->|no fences needed| view[Still renders]

%% A bare .mmd file: the whole file is one diagram
""",
}


def frame(obj: dict) -> bytes:
    body = json.dumps(obj).encode()
    return b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body


def main() -> int:
    if os.name != "nt" and not SERVER.is_file():
        pass
    if not SERVER.is_file():
        print(f"error: {SERVER} missing — run: cargo build --release -p mermaid-view-server")
        return 1

    parser = argparse.ArgumentParser()
    parser.add_argument("--theme", choices=["light", "dark"], default="dark")
    parser.add_argument("--watch", nargs="*", help="extra files to didOpen and keep live")
    args = parser.parse_args()

    FIXTURE_DIR.mkdir(exist_ok=True)
    extra = [Path(p) for p in (args.watch or [])]

    doc_paths = []
    for name, text in FIXTURES.items():
        path = FIXTURE_DIR / name
        path.write_text(text, newline="\n")
        doc_paths.append(path.resolve())
    doc_paths += [p.resolve() for p in extra if p.is_file()]

    proc = subprocess.Popen(
        [str(SERVER)],
        cwd=str(REPO),
        env={**os.environ},  # browser will auto-open the canvas
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
    )

    proc.stdin.write(frame({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "processId": None,
            "rootUri": REPO.as_uri(),
            "capabilities": {},
            "initializationOptions": {"theme": args.theme},
        },
    }))
    proc.stdin.write(frame({"jsonrpc": "2.0", "method": "initialized", "params": {}}))
    for path in doc_paths:
        proc.stdin.write(frame({
            "jsonrpc": "2.0", "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": path.as_uri(),
                    "languageId": "markdown" if path.suffix != ".mmd" else "mermaid",
                    "version": 1,
                    "text": path.read_text(),
                }
            },
        }))
    proc.stdin.flush()

    REPO.joinpath("dev-server.pid").write_text(str(proc.pid))
    print(f"MermaidView dev server running — {len(doc_paths)} fixture file(s) loaded.")
    print("Stop with Ctrl+C (server exits when this process does).")
    try:
        # Keep the pipe alive. Ctrl+C interrupts below; the spawned server dies with us.
        while proc.poll() is None:
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\nstopping…")
    finally:
        try:
            proc.stdin.close()
        except OSError:
            pass
        proc.kill()
        REPO.joinpath("dev-server.pid").unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())