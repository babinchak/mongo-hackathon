"""Stage 2b: strict second pass over durable moments (nano over-labels one-off requests as durable)."""
import argparse
import os
from concurrent.futures import ThreadPoolExecutor

from hindsight.db import db
from hindsight.llm import chat_json, embed

SYSTEM = """You audit candidate "project memories" extracted from a developer's sessions with a \
coding agent. Keep a memory ONLY if it is general project knowledge that would change how an agent \
does a DIFFERENT, future task in this repo — a standing rule, convention, design decision, \
environment fact, required procedure, or approach known not to work.

REJECT: one-off requests ("fix this comment", "add a todo for X", "kill the api"), bug reports \
about the change in progress, anything tied to one PR/phase/ticket/CI run, status questions, \
and statements that are only true for that moment.

If kept, rewrite the statement as a general, self-contained rule for a future agent: keep exact \
identifiers (commands, files, packages, branches, services) but drop PR numbers, phase numbers, \
URLs and session-specific context. One sentence."""

SCHEMA = {
    "type": "object",
    "properties": {"keep": {"type": "boolean"}, "statement": {"type": "string"}, "reason": {"type": "string"}},
    "required": ["keep", "statement", "reason"],
    "additionalProperties": False,
}


def _audit(m):
    src = db().memory.find_one({"_id": m["source_turn_id"]}, {"text": 1}) or {}
    user = (f"CANDIDATE ({m['moment_kind']}): {m['text']}\n\n"
            f"DEVELOPER'S ORIGINAL WORDS:\n{src.get('text', '')[:1500]}")
    return chat_json(os.environ.get("LINK_MODEL", "gpt-5.4-mini"), SYSTEM, user, SCHEMA, "audit")


def refine(repo_id: str, workers: int = 16):
    col = db().memory
    ms = list(col.find({"kind": "moment", "repo_id": repo_id, "durable": True, "refined": {"$ne": True}}, {"embedding": 0}))
    with ThreadPoolExecutor(workers) as ex:
        outs = list(ex.map(_audit, ms))
    kept = [(m, o) for m, o in zip(ms, outs) if o["keep"] and o["statement"].strip()]
    vecs = embed([o["statement"] for _, o in kept])
    for m, o in zip(ms, outs):
        if not (o["keep"] and o["statement"].strip()):
            col.update_one({"_id": m["_id"]}, {"$set": {"durable": False, "refined": True, "raw_text": m["text"],
                                                        "refine_reason": o["reason"]}, "$unset": {"embedding": ""}})
    for (m, o), v in zip(kept, vecs):
        col.update_one({"_id": m["_id"]}, {"$set": {"text": o["statement"].strip(), "raw_text": m["text"],
                                                    "refined": True, "embedding": v}})
    print(f"{repo_id}: kept {len(kept)}/{len(ms)} durable moments after strict audit")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True)
    refine(p.parse_args().repo)
