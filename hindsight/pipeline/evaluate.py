"""Run pi on a case under one harness config, judge the plan, and record a `runs` doc.

Used by validation (repo_only vs oracle), the config sweep, and the UI's "Run now".
"""
import os
import uuid
from datetime import datetime, timezone

from hindsight.db import db
from hindsight.llm import chat_json
from hindsight.snapshots import snapshot

JUDGE_SYSTEM = """You grade a coding agent's PLAN against a hidden expectation. The agent was given \
only the task and a read-only view of the repository (and possibly a memory tool).

PASS only if the plan follows the expected behavior. FAIL if it does what the fail signals \
describe, or if it ignores the expectation in a way that would lead to the wrong outcome. A plan \
that explicitly avoids a fail signal (e.g. "don't use git tag") is not failing because of it. \
If the plan is vague and never reaches the point the expectation is about, FAIL."""

JUDGE_SCHEMA = {
    "type": "object",
    "properties": {"verdict": {"type": "string", "enum": ["pass", "fail"]}, "reason": {"type": "string"}},
    "required": ["verdict", "reason"],
    "additionalProperties": False,
}


def judge(case: dict, plan: str) -> dict:
    literal = [s for s in case["fail_signals"] if s.lower() in plan.lower()]
    user = (f"TASK:\n{case['task']}\n\nEXPECTED BEHAVIOR:\n{case['expected']}\n\n"
            f"FAIL SIGNALS:\n" + "\n".join(f"- {s}" for s in case["fail_signals"]) +
            f"\n\nFAIL SIGNALS APPEARING LITERALLY IN THE PLAN (check context): {literal or 'none'}\n\n"
            f"AGENT PLAN:\n{plan}")
    return chat_json(os.environ.get("JUDGE_MODEL", "gpt-6-luna"), JUDGE_SYSTEM, user, JUDGE_SCHEMA, "verdict")


def oracle_notes(case: dict) -> str:
    docs = list(db().memory.find({"_id": {"$in": case["gold_evidence"]}}, {"text": 1, "ts": 1, "kind": 1}))
    lines = [f"- ({d['ts']:%Y-%m-%d}) {d['text'][:1200]}" for d in sorted(docs, key=lambda d: d["ts"])]
    return "Notes from earlier sessions on this project:\n" + "\n".join(lines)


def execute(case: dict, config_id: str, horizon_days: int | None = None, repeat: int = 0,
            phase: str = "sweep", api_base: str = "http://127.0.0.1:8000") -> dict:
    from hindsight.runner.pi_runner import run_pi

    cut = next((c for c in case["cutoffs"] if c["horizon_days"] == horizon_days), case["cutoffs"][0])
    path = snapshot(case["repo_id"], cut["cutoff"])
    extra = oracle_notes(case) if config_id == "oracle" else None
    res = run_pi(str(path), case["task"], config_id=config_id, repo_id=case["repo_id"],
                 cutoff=cut["cutoff"], api_base=api_base, extra_system=extra)
    if res.get("error") or not res.get("response"):
        verdict = {"verdict": "error", "reason": res.get("error") or "empty response"}
    else:
        verdict = judge(case, res["response"])
    context_ids = res.get("context_ids", [])
    run = {
        "_id": str(uuid.uuid4()), "case_id": case["_id"], "config_id": config_id, "phase": phase,
        "repeat": repeat, "horizon_days": cut["horizon_days"], "cutoff": cut["cutoff"],
        "commit": cut.get("commit"), "model": res.get("model"), "tool_calls": res.get("tool_calls", []),
        "used_memory_tool": res.get("used_memory_tool", False), "context_ids": context_ids,
        "hit_gold": bool(set(context_ids) & set(case["gold_evidence"])), "response": res.get("response", ""),
        "verdict": verdict["verdict"], "reason": verdict["reason"], "cost_usd": res.get("cost_usd", 0.0),
        "turns": res.get("turns"), "duration_s": res.get("duration_s"),
        "created_at": datetime.now(timezone.utc),
    }
    db().runs.insert_one(run)
    return run
