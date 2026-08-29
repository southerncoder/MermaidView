"""E2E for standalone CLI mode: index + HTTP API + live file watcher.

Run from repo root (release build present):
    python scripts/e2e_standalone.py
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from tempfile import mkdtemp

SERVER = Path(__file__).resolve().parent.parent / "target" / "release" / "mermaid-view-server.exe"
PORT_RE = re.compile(r"preview ready at http://127\.0\.0\.1:(\d+)")


def main() -> int:
    tmp = Path(mkdtemp(prefix="mv-standalone-"))
    (tmp / "a.md").write_text(
        "# T\n\n```mermaid\nflowchart TD\n  A --> B\n```\n", newline="\n"
    )
    (tmp / "b.mmd").write_text("pie title X\n  \"a\": 3\n", newline="\n")
    (tmp / "notes.txt").write_text("```mermaid\nflowchart LR\n X --> Y\n```\n")  # must be ignored

    os.environ["MERMAID_VIEW_NO_BROWSER"] = "1"
    proc = subprocess.Popen(
        [str(SERVER), "standalone", str(tmp), "--no-browser", "--theme", "light"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    import threading
    found = {}
    stderr_lines = []

    def reader():
        for line in iter(proc.stderr.readline, b""):
            s = line.decode(errors="replace")
            stderr_lines.append(s)
            m = PORT_RE.search(s)
            if m:
                found["port"] = m.group(1)

    t = threading.Thread(target=reader, daemon=True)
    t.start()
    deadline = time.time() + 10
    while time.time() < deadline and "port" not in found:
        time.sleep(0.05)
    if "port" not in found:
        print("FAIL: no port; stderr:", "".join(stderr_lines))
        proc.kill()
        return 1
    port = found["port"]

    def diagrams(q):
        with urllib.request.urlopen(f"http://127.0.0.1:{q}/api/diagrams", timeout=5) as r:
            return json.load(r)

    data = diagrams(port)
    files = {d["file"].split("/")[-1] for d in data["diagrams"]}
    ok = True

    def check(name, cond, detail=""):
        nonlocal ok
        print(("  PASS " if cond else "  FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
        ok = ok and cond

    check("standalone: indexed both files, ignored .txt",
          files == {"a.md", "b.mmd"} and len(data["diagrams"]) == 2, str(files))
    check("standalone: theme flag not in API (server-side ok)", data.get("activeFile", "") is None)

    # Watcher: edit a.md, expect the update to appear
    (tmp / "a.md").write_text(
        "# T2\n\n```mermaid\nflowchart TD\n  A --> B --> C\n```\n", newline="\n"
    )
    picked = False
    for _ in range(60):  # up to 6s
        time.sleep(0.1)
        try:
            d2 = diagrams(port)
        except Exception:
            continue
        a = [x for x in d2["diagrams"] if x["file"].endswith("a.md")]
        if a and "B --> C" in a[0]["source"]:
            picked = True
            break
    check("standalone: watcher picked up live edit", picked)

    # Watcher: new .mmd file appears
    (tmp / "new.mmd").write_text("flowchart LR\n  K --> L\n", newline="\n")
    added = False
    for _ in range(60):
        time.sleep(0.1)
        try:
            d3 = diagrams(port)
        except Exception:
            continue
        if any(x["file"].endswith("new.mmd") for x in d3["diagrams"]):
            added = True
            break
    check("standalone: watcher indexed a newly created file", added)

    proc.kill()
    import shutil
    shutil.rmtree(tmp, ignore_errors=True)
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())