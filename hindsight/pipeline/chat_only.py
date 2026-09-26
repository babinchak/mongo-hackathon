"""Stage 5: drop cases whose answer the repo itself already documents at the cutoff."""
import argparse
import json
import os
from concurrent.futures import ThreadPoolExecutor

from hindsight.db import db
from hindsight.llm import chat_json
from hindsight.snapshots import commit_at, grep_snapshot, snapshot

SYSTEM = """You check whether a code repository ALREADY documents a piece of project knowledge. \
You get the knowledge, the behavior a correct agent plan must show, and grep excerpts from the \
repo at that point in time (docs, agent instruction files, config, code).

answered_by_repo = true if an agent that reads these files would likely learn the knowledge and \
behave correctly without any chat history (the rule is stated, or the config/code makes it \
obvious). false if the excerpts only mention related words without stating the rule."""

SCHEMA = {
    "type": "object",
    "properties": {"answered_by_repo": {"type": "boolean"}, "where": {"type": "string"}, "reason": {"type": "string"}},
    "required": ["answered_by_repo", "where", "reason"],
    "additionalProperties": False,
}


def prepare(case) -> None:
    """Resolve commits and build the first-cutoff snapshot (serially: git work isn't thread-safe)."""
    for c in case["cutoffs"]:
        if not c.get("commit"):
            c["commit"] = commit_at(case["repo_id"], c["cutoff"])[0]
    case["_snapshot"] = snapshot(case["repo_id"], case["cutoffs"][0]["cutoff"])


def check(case) -> dict:
    path = case.pop("_snapshot")
    hits = grep_snapshot(path, case["keywords"])
    moment = db().memory.find_one({"_id": case["moment_id"]}, {"text": 1}) or {}
    if not hits:
        verdict = {"answered_by_repo": False, "where": "", "reason": "no keyword hits in snapshot"}
    else:
        user = (f"KNOWLEDGE: {moment.get('text')}\nCORRECT BEHAVIOR: {case['expected']}\n\n"
                f"REPO EXCERPTS:\n{json.dumps(hits, indent=1)[:12000]}")
        verdict = chat_json(os.environ.get("LINK_MODEL", "gpt-5.4-mini"), SYSTEM, user, SCHEMA, "chat_only")
    chat_only = not verdict["answered_by_repo"]
    db().cases.update_one({"_id": case["_id"]}, {"$set": {
        "cutoffs": case["cutoffs"], "chat_only": chat_only, "chat_only_check": verdict,
        "status": "generated" if chat_only else "filtered_out"}})
    return {"id": case["_id"], "chat_only": chat_only, **verdict}


def run(repo_id: str, workers: int = 6):
    cases = list(db().cases.find({"repo_id": repo_id, "chat_only": None}))
    for c in cases:
        prepare(c)
    with ThreadPoolExecutor(workers) as ex:
        results = list(ex.map(check, cases))
    for r in results:
        print(("KEEP " if r["chat_only"] else "DROP ") + r["id"], "·", r["where"] or r["reason"][:80])
    print(f"{repo_id}: {sum(r['chat_only'] for r in results)}/{len(results)} cases are chat-only")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True)
    run(p.parse_args().repo)
