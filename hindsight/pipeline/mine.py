"""Stage 2: turn developer pushback into typed, self-contained memory moments."""
import argparse
import os
from concurrent.futures import ThreadPoolExecutor

from pymongo import UpdateOne

from hindsight.db import db
from hindsight.llm import chat_json, embed
from hindsight.memory.search import FAR

SYSTEM = """You read one exchange from a developer's real session with a coding agent: the agent's \
last message, then the developer's reply, which pushed back on the agent.

Decide whether the reply contains durable project knowledge: something an agent working on a \
DIFFERENT task in this repo weeks later would get wrong without knowing it.

kind:
- constraint: a rule that must always/never be followed ("never push to main", "use pnpm not npm")
- decision: a design or tooling choice the project made ("we store keys in IndexedDB, not localStorage")
- fact: a non-obvious truth about the project/environment ("staging deploys from the dev branch")
- procedure: how something must be done here ("release by merging the release-please PR")
- failed_approach: something tried that does not work here and should not be retried
- none: one-off instruction, bug report about this exact change, frustration, style nit, or \
anything only meaningful inside this session

statement: ONE self-contained sentence stating the knowledge as a rule/fact for a future agent. \
Keep exact identifiers (file names, commands, packages, branch names). Neutral tone. Empty if none.
topic: 1-3 lowercase words (e.g. "release process", "encryption", "testing").
confidence: 1-5 that this is durable and correctly stated (5 = explicit, general, clearly still true later)."""

SCHEMA = {
    "type": "object",
    "properties": {
        "kind": {"type": "string", "enum": ["constraint", "decision", "fact", "procedure", "failed_approach", "none"]},
        "statement": {"type": "string"},
        "topic": {"type": "string"},
        "confidence": {"type": "integer"},
    },
    "required": ["kind", "statement", "topic", "confidence"],
    "additionalProperties": False,
}


def _prev_assistant(turn):
    return db().memory.find_one(
        {"kind": "turn", "session_id": turn["session_id"], "role": "assistant", "seq": {"$lt": turn["seq"]}},
        sort=[("seq", -1)], projection={"text": 1},
    )


def classify(turn) -> dict:
    prev = _prev_assistant(turn)
    agent = (prev or {}).get("text", "(no agent message)")
    agent = agent if len(agent) <= 2500 else "…" + agent[-2500:]
    user = f"AGENT:\n{agent}\n\nDEVELOPER ({turn.get('pushback')}):\n{turn['text'][:3000]}"
    out = chat_json(os.environ.get("MINE_MODEL", "gpt-5.4-nano"), SYSTEM, user, SCHEMA, "moment")
    out["evidence"] = [turn["_id"]] + ([prev["_id"]] if prev else [])
    return out


def mine(repo_id: str, limit: int | None = None, workers: int = 16):
    done = {d["source_turn_id"] for d in db().memory.find({"kind": "moment", "repo_id": repo_id}, {"source_turn_id": 1})}
    q = {"kind": "turn", "repo_id": repo_id, "role": "user", "noise": False, "pushback": {"$ne": None}}
    turns = [t for t in db().memory.find(q, {"embedding": 0}).sort("ts", 1) if t["_id"] not in done]
    if limit:
        turns = turns[:limit]
    print(f"{repo_id}: {len(turns)} pushback turns to mine ({len(done)} already mined)")
    with ThreadPoolExecutor(workers) as ex:
        results = list(ex.map(classify, turns))
    docs = []
    for t, r in zip(turns, results):
        durable = r["kind"] != "none" and r["confidence"] >= 3 and bool(r["statement"].strip())
        docs.append({
            "_id": f"m:{t['_id']}", "kind": "moment", "repo_id": repo_id, "session_id": t["session_id"],
            "seq": t["seq"], "ts": t["ts"], "text": r["statement"].strip(), "moment_kind": r["kind"],
            "topic": r["topic"].strip().lower(), "confidence": r["confidence"], "durable": durable,
            "source_turn_id": t["_id"], "evidence": r["evidence"], "pushback": t.get("pushback"),
            "repeats": [], "repeated_by": [], "supersedes": [], "superseded_by": [], "superseded_at": FAR,
        })
    durable_docs = [d for d in docs if d["durable"]]
    for d, e in zip(durable_docs, embed([d["text"] for d in durable_docs])):
        d["embedding"] = e
    if docs:
        db().memory.bulk_write([UpdateOne({"_id": d["_id"]}, {"$set": d}, upsert=True) for d in docs])
    kinds = {}
    for d in durable_docs:
        kinds[d["moment_kind"]] = kinds.get(d["moment_kind"], 0) + 1
    print(f"mined {len(docs)} · durable {len(durable_docs)} · {kinds}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True)
    p.add_argument("--limit", type=int)
    a = p.parse_args()
    mine(a.repo, a.limit)
