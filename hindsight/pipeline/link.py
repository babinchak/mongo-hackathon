"""Stage 3: link each durable moment to earlier ones it repeats or supersedes."""
import argparse
import os
from concurrent.futures import ThreadPoolExecutor

from hindsight.db import db
from hindsight.llm import chat_json
from hindsight.memory.search import FAR

SYSTEM = """Two statements of project knowledge were extracted from a developer's sessions with a \
coding agent, EARLIER and LATER. Classify their relation:
- same: they state the same rule/fact (the developer had to repeat themselves)
- updates: the LATER one changes or reverses the EARLIER one about the SAME thing, so following \
EARLIER would now be WRONG. They must directly conflict: an agent could not follow both at once.
- related: same area but both can still be followed (different aspects, different situations, \
one adds detail or scope to the other)
- unrelated: different topics

Most pairs are related or unrelated. Be strict: first decide can_follow_both; if true, the relation \
cannot be "updates"."""

SCHEMA = {
    "type": "object",
    "properties": {"can_follow_both": {"type": "boolean"},
                   "relation": {"type": "string", "enum": ["same", "updates", "related", "unrelated"]},
                   "reason": {"type": "string"}},
    "required": ["can_follow_both", "relation", "reason"],
    "additionalProperties": False,
}


def _candidates(m, min_score=0.6, top=3):
    pipeline = [
        {"$vectorSearch": {"index": "memory_vec", "path": "embedding", "queryVector": m["embedding"],
                           "numCandidates": 100, "limit": 10,
                           "filter": {"$and": [{"repo_id": m["repo_id"]}, {"ts": {"$lt": m["ts"]}},
                                               {"kind": "moment"}, {"durable": True}]}}},
        {"$project": {"text": 1, "session_id": 1, "ts": 1, "score": {"$meta": "vectorSearchScore"}}},
    ]
    return [c for c in db().memory.aggregate(pipeline)
            if c["session_id"] != m["session_id"] and c["score"] >= min_score][:top]


def _judge(m):
    out = []
    for c in _candidates(m):
        r = chat_json(os.environ.get("LINK_MODEL", "gpt-6-sol"), SYSTEM,
                      f"EARLIER ({c['ts']:%Y-%m-%d}): {c['text']}\nLATER ({m['ts']:%Y-%m-%d}): {m['text']}",
                      SCHEMA, "relation")
        rel = "related" if r["relation"] == "updates" and r["can_follow_both"] else r["relation"]
        out.append((c, rel))
    return m, out


def link(repo_id: str, workers: int = 12):
    col = db().memory
    moments = list(col.find({"kind": "moment", "repo_id": repo_id, "durable": True}))
    col.update_many({"kind": "moment", "repo_id": repo_id},
                    {"$set": {"repeats": [], "repeated_by": [], "supersedes": [], "superseded_by": []}})
    counts = {"same": 0, "updates": 0}
    with ThreadPoolExecutor(workers) as ex:
        for m, rels in ex.map(_judge, moments):
            for c, rel in rels:
                if rel == "same":
                    col.update_one({"_id": m["_id"]}, {"$addToSet": {"repeats": c["_id"]}})
                    col.update_one({"_id": c["_id"]}, {"$addToSet": {"repeated_by": m["_id"]}})
                elif rel == "updates":
                    col.update_one({"_id": m["_id"]}, {"$addToSet": {"supersedes": c["_id"]}})
                    col.update_one({"_id": c["_id"]}, {"$addToSet": {"superseded_by": m["_id"]}})
                if rel in counts:
                    counts[rel] += 1
    # superseded_at = earliest superseding moment (drives the as-of-cutoff filter)
    for m in col.find({"kind": "moment", "repo_id": repo_id}, {"superseded_by": 1}):
        ts = [d["ts"] for d in col.find({"_id": {"$in": m.get("superseded_by", [])}}, {"ts": 1})]
        col.update_one({"_id": m["_id"]}, {"$set": {"superseded_at": min(ts) if ts else FAR}})
    print(f"{repo_id}: {len(moments)} durable moments · repeats {counts['same']} · supersedes {counts['updates']}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True)
    link(p.parse_args().repo)
