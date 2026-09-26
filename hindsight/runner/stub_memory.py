"""Canned memory service for testing the pi harness without Atlas.

uv run python -m hindsight.runner.stub_memory [--port 8765]

Implements the CONTRACTS.md memory API (+ GET /api/configs/:id) with fixed items and logs
every request to stderr.
"""

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ITEMS = [
    {
        "id": "m:stub-release-1", "kind": "moment", "ts": "2026-01-20T15:02:00Z",
        "session_id": "stub-s1", "score": 0.91, "moment_kind": "constraint", "topic": "release",
        "source_turn_id": "stub-release-1",
        "text": "Releases are cut only by merging the release-please PR on main. Never push git tags "
                "by hand; the CI publish job creates the tag.",
    },
    {
        "id": "m:stub-branch-2", "kind": "moment", "ts": "2026-01-22T09:40:00Z",
        "session_id": "stub-s2", "score": 0.84, "moment_kind": "decision", "topic": "git",
        "source_turn_id": "stub-branch-2",
        "text": "Feature work goes on branches named feat/<short-topic>; commits use Conventional "
                "Commits (feat:, fix:, chore:).",
    },
    {
        "id": "stub-turn-3", "kind": "turn", "ts": "2026-01-20T14:58:00Z",
        "session_id": "stub-s1", "score": 0.62,
        "text": "No, don't run `git tag v0.3.0 && git push --tags` again. Last time that double-published "
                "the package. Merge the release PR and let CI do it.",
    },
]

BRIEFING = {
    "text": "- Releases: merge the release-please PR on main; never hand-push git tags (CI tags).\n"
            "- Branches: feat/<topic>; Conventional Commits.",
    "ids": ["m:stub-release-1", "m:stub-branch-2"],
}


def config(config_id: str) -> dict | None:
    if config_id in ("repo_only", "oracle"):
        return {"_id": config_id, "memory": False, "briefing": False}
    return {"_id": config_id, "memory": True, "retrieval": "hybrid", "source": "moments+turns",
            "k": 8, "briefing": config_id.endswith("_brief"), "drop_superseded": True}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/api/configs/"):
            cfg = config(self.path.rsplit("/", 1)[1])
            return self._send(200, cfg) if cfg else self._send(404, {"detail": "not found"})
        self._send(404, {"detail": "not found"})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        print(f"[stub] {self.path} {json.dumps(body)[:300]}", file=sys.stderr, flush=True)
        if self.path == "/api/memory/search":
            return self._send(200, {"items": ITEMS[: body.get("k") or 8]})
        if self.path == "/api/memory/briefing":
            return self._send(200, BRIEFING)
        self._send(404, {"detail": "not found"})

    def log_message(self, fmt, *args):
        print(f"[stub] {fmt % args}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    port = ap.parse_args().port
    print(f"stub memory service on http://127.0.0.1:{port}", file=sys.stderr, flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
