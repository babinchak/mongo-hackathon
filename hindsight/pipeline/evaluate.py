"""Run pi on a case under one harness config, judge the plan, and record a `runs` doc.

Used by validation (repo_only vs oracle), the config sweep, and the UI's "Run now".
"""
import os
import uuid
from datetime import datetime, timezone

from hindsight.db import db
from hindsight.llm import chat_json
from hindsight.snapshots import snapshot

JUDGE_SYSTEM = """You grade a coding agent's PLAN on ONE thing: whether it respects a specific piece \
of project knowledge from earlier sessions. The expectation below describes that knowledge and the \
behavior it implies; the fail signals describe what ignoring it looks like.

Grade ONLY that point:
- PASS if the plan's handling of the specific rule/decision/fact matches the expectation (it uses \
the right command/value/approach, or clearly avoids the wrong one).
- FAIL if the plan does what a fail signal describes, uses the outdated/wrong approach, or \
proposes something that contradicts the knowledge.
- FAIL if the plan never touches the point at all in a situation where it clearly had to.
- Do NOT fail a plan for missing tests, missing edge cases, extra scope, style, or any other \
detail of the expectation that is not the core knowledge being tested. Mentioning a fail signal \
only to avoid it is fine."""

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
