#!/usr/bin/env python3
"""Inspect a pi-rs session JSONL file for tool-execution diagnostics.

Summarizes every assistant toolCall and its matching toolResult, flagging
errors and the bash "Working directory does not exist" failure in particular.
Useful for diagnosing why tools fail without re-reading raw JSONL by hand.

Usage:
    python3 scripts/inspect_session.py [path-to-session.jsonl]

With no argument, inspects the most recently modified session in
~/.pi-rs/agent/sessions/.

Output sections:
  header  — session id, cwd, parent_session
  summary — counts of toolCall / toolResult / error results
  calls   — per toolCall: id, name, args (truncated)
  results — per toolResult: id, is_error, result text (truncated)
  orphans — toolCalls with no matching toolResult (interrupted/aborted)
"""
import json
import sys
from pathlib import Path
from typing import Optional

SESSIONS_DIR = Path.home() / ".pi-rs" / "agent" / "sessions"


def pick_file(arg: Optional[str]) -> Path:
    if arg:
        return Path(arg)
    files = sorted(SESSIONS_DIR.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        sys.exit(f"No session files found in {SESSIONS_DIR}")
    return files[0]


def main() -> None:
    path = pick_file(sys.argv[1] if len(sys.argv) > 1 else None)
    print(f"FILE: {path}")

    header_cwd = None
    parent = None
    calls: list[tuple[str, str, object]] = []
    results: list[tuple[str, bool, str]] = []

    for line in path.read_text().splitlines():
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if d.get("type") == "session":
            header_cwd = d.get("cwd")
            parent = d.get("parent_session")
            continue
        m = d.get("message", d)
        role = m.get("role")
        if role == "assistant":
            for b in m.get("content", []):
                if b.get("type") == "toolCall":
                    calls.append((b.get("id", ""), b.get("name", "?"), b.get("arguments")))
        elif role == "toolResult":
            text = " ".join(b.get("text", "") for b in m.get("content", []) if b.get("type") == "text")
            results.append((m.get("tool_call_id", ""), bool(m.get("is_error")), text))

    print(f"\nheader  cwd={header_cwd!r} parent={parent!r}")
    err_count = sum(1 for _, is_err, txt in results if is_err or "Working directory does not exist" in txt)
    print(f"summary toolCall={len(calls)} toolResult={len(results)} error_results={err_count}")

    print("\n--- toolCall ---")
    for cid, name, args in calls:
        a = json.dumps(args, ensure_ascii=False)
        print(f"  {cid}  {name}  {a[:140]}")

    print("\n--- toolResult ---")
    for cid, is_err, txt in results:
        flag = "ERROR" if (is_err or "Working directory does not exist" in txt) else "ok"
        print(f"  [{flag}] {cid}  is_error={is_err}  {txt[:160]!r}")

    matched = {cid for cid, _, _ in results}
    orphans = [cid for cid, _, _ in calls if cid not in matched]
    if orphans:
        print(f"\n--- orphan toolCalls (no toolResult, likely interrupted): {len(orphans)} ---")
        for cid in orphans:
            print(f"  {cid}")


if __name__ == "__main__":
    main()