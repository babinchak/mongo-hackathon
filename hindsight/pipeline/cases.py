"""Stage 4: turn durable moments into eval cases with cutoffs at several horizons."""
import argparse
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from hindsight.db import db
from hindsight.llm import chat_json

HORIZONS = [1, 7, 21]

SYSTEM = """You write evaluation cases for a coding-agent MEMORY benchmark, mined from a real \
project's development history. You get one piece of durable project knowledge that the developer \
told an agent in an earlier session, plus context.

Write a realistic FUTURE task this developer might give a fresh agent weeks later, where an agent \
that does not remember this knowledge would plausibly do the wrong thing.

Rules:
- The task must NOT mention, hint at, or paraphrase the knowledge. It should read like a normal \
request ("Cut a release for the new sharing feature", "Add an integration test for upload").
- The task must be answerable as a PLAN (the agent only investigates read-only and proposes \
steps, commands, files, branch names); no need to actually edit code.
- expected: what a correct plan must do or avoid, citing the knowledge concretely.
- fail_signals: 1-3 concrete, checkable things a wrong plan would contain (exact commands, file \
names, package names, branch patterns). For a superseded decision, include the OLD approach.
- keywords: 3-6 distinctive strings the correct answer depends on (identifiers, commands, file \
names), used to grep the repo to see whether the repo itself already documents this.
- If the knowledge cannot support a fair task (too vague, only meaningful inside that session), \
set usable=false."""

SCHEMA = {
    "type": "object",
    "properties": {
        "usable": {"type": "boolean"},
        "task": {"type": "string"},
        "expected": {"type": "string"},
        "fail_signals": {"type": "array", "items": {"type": "string"}},
        "keywords": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["usable", "task", "expected", "fail_signals", "keywords"],
    "additionalProperties": False,
}


def _scenario(m):
    if m.get("supersedes"):
        return "superseded_decision"
    if m.get("moment_kind") == "failed_approach":
        return "failed_approach"
    return "durable_constraint"


def _priority(m):
    return (bool(m.get("repeated_by")), bool(m.get("supersedes")), m.get("confidence", 0))


def _cutoffs(m, session_starts):
    out = []
    for h in HORIZONS:
        target = m["ts"] + timedelta(days=h)
        nxt = next((s for s in session_starts if s["started_at"] >= target), None)
        if nxt is None or nxt["started_at"] >= m["superseded_at"]:
            continue
        out.append({"horizon_days": h, "cutoff": nxt["started_at"], "session_id": nxt["_id"], "commit": None})
    return out


def _generate(m):
    col = db().memory
    source = col.find_one({"_id": m["source_turn_id"]}, {"text": 1}) or {}
    old = [d["text"] for d in col.find({"_id": {"$in": m.get("supersedes", [])}}, {"text": 1})]
    user = (f"KNOWLEDGE ({m['moment_kind']}, topic: {m.get('topic')}, said {m['ts']:%Y-%m-%d}):\n{m['text']}\n\n"
            f"DEVELOPER'S ORIGINAL WORDS:\n{source.get('text', '')[:1500]}\n")
    if old:
        user += "\nTHIS REPLACED AN EARLIER DECISION (the old approach, now wrong):\n" + "\n".join(f"- {o}" for o in old)
    return chat_json(os.environ.get("CASE_MODEL", "gpt-5.4"), SYSTEM, user, SCHEMA, "case")


def generate(repo_id: str, n: int = 30, workers: int = 8):
    starts = list(db().sessions.find({"repo_id": repo_id}, {"started_at": 1}).sort("started_at", 1))
    existing = {c["moment_id"] for c in db().cases.find({"repo_id": repo_id}, {"moment_id": 1})}
    moments = [m for m in db().memory.find({"kind": "moment", "repo_id": repo_id, "durable": True}, {"embedding": 0})
               if m["_id"] not in existing]
    picked = []
    for m in sorted(moments, key=_priority, reverse=True):
        cuts = _cutoffs(m, starts)
        if cuts:
            picked.append((m, cuts))
        if len(picked) >= n:
            break
    print(f"{repo_id}: generating {len(picked)} cases from {len(moments)} unused durable moments")
    with ThreadPoolExecutor(workers) as ex:
        outs = list(ex.map(lambda mc: _generate(mc[0]), picked))
    kept = 0
    for (m, cuts), o in zip(picked, outs):
        if not o["usable"]:
            continue
        gold = [m["_id"]] + m.get("evidence", []) + m.get("repeats", [])
        db().cases.replace_one({"_id": f"c:{m['_id']}"}, {
            "_id": f"c:{m['_id']}", "repo_id": repo_id, "moment_id": m["_id"], "scenario": _scenario(m),
            "task": o["task"], "expected": o["expected"], "fail_signals": o["fail_signals"],
            "keywords": o["keywords"], "gold_evidence": gold, "cutoffs": cuts,
            "repeated_in_real_life": bool(m.get("repeated_by")), "chat_only": None,
            "status": "generated", "validation": {}, "review": None,
        }, upsert=True)
        kept += 1
    print(f"kept {kept} usable cases")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True)
    p.add_argument("-n", type=int, default=30)
    a = p.parse_args()
    generate(a.repo, a.n)
