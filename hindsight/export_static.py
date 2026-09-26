"""Export a read-only JSON snapshot of the API for the static (hosted) UI.

Raw SWE-chat text is not published: case source turns and the developer's original words on
moments are dropped; only mined rules, cases, runs and aggregates are exported.

uv run python -m hindsight.export_static --out ui/dist-static/data   (after `npm run build:static`)
"""
import argparse
import json
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPOS = ["FSM1/cipher-box", "marcus-sa/brain", "melagiri/code-insights"]
PRIVATE_MOMENT_FIELDS = ("source_text", "raw_text")


def slug(repo_id: str) -> str:
    return repo_id.replace("/", "__")


def case_file(case_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9-]", "_", case_id)


def _moment(m: dict | None) -> dict | None:
    return {k: v for k, v in m.items() if k not in PRIVATE_MOMENT_FIELDS} if m else m


def export(out: Path, api: str):
    def get(path: str, **params):
        q = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        with urllib.request.urlopen(f"{api}{path}{'?' + q if q else ''}", timeout=120) as r:
            return json.load(r)

    def put(rel: str, data) -> None:
        p = out / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))

    put("funnel.json", get("/api/funnel"))
    put("leaderboard.json", get("/api/leaderboard"))
    for name in ("configs", "tuning", "spend", "judge_audit"):
        put(f"{name}.json", get(f"/api/{name}"))

    n_cases = 0
    for repo in REPOS:
        s = slug(repo)
        put(f"funnel/{s}.json", get("/api/funnel", repo_id=repo))
        put(f"leaderboard/{s}.json", get("/api/leaderboard", repo_id=repo))
        timeline = get("/api/timeline", repo_id=repo)
        timeline["moments"] = [_moment(m) for m in timeline["moments"]]
        put(f"timeline/{s}.json", timeline)
        put(f"moments/{s}.json", [_moment(m) for m in get("/api/moments", repo_id=repo, durable="true", limit=5000)])
        put(f"moments/{s}.rejected.json",
            [_moment(m) for m in get("/api/moments", repo_id=repo, durable="false", limit=5000)])
        cases = get("/api/cases", repo_id=repo)
        put(f"cases/{s}.json", cases)
        for c in cases:
            detail = get(f"/api/cases/{urllib.parse.quote(c['_id'], safe='')}")
            detail["source_turns"] = []
            detail["moment"] = _moment(detail.get("moment"))
            put(f"case/{case_file(c['_id'])}.json", detail)
            n_cases += 1

    n_runs = 0
    for cfg in get("/api/configs"):
        runs = get("/api/runs", config_id=cfg["_id"])
        if not runs:
            continue
        put(f"runs/{case_file(cfg['_id'])}.json", runs)
        for r in runs:
            trace = get(f"/api/runs/{urllib.parse.quote(r['_id'], safe='')}")
            for m in trace["memory"]:
                if m["kind"] == "turn":  # raw chat text is not published
                    m["text"] = ""
                    m["redacted"] = True
            put(f"run/{case_file(r['_id'])}.json", trace)
            n_runs += 1

    put("meta.json", {"exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "repos": REPOS})
    size = sum(p.stat().st_size for p in out.rglob("*.json"))
    print(f"exported {n_cases} case pages, {n_runs} run traces · {size / 1e6:.1f} MB → {out}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="ui/dist-static/data")
    p.add_argument("--api", default="http://127.0.0.1:8000")
    a = p.parse_args()
    export(Path(a.out), a.api)
