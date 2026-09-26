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
- updates: the LATER one changes or reverses the EARLIER one, so following EARLIER would now be \
WRONG. Only use this if following the earlier statement today would be a mistake.
- related: same topic but both remain true and independent
- unrelated: different topics"""

SCHEMA = {
    "type": "object",
    "properties": {"relation": {"type": "string", "enum": ["same", "updates", "related", "unrelated"]},
                   "reason": {"type": "string"}},
    "required": ["relation", "reason"],
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
        r = chat_json(os.environ.get("LINK_MODEL", "gpt-5.4-mini"), SYSTEM,
                      f"EARLIER ({c['ts']:%Y-%m-%d}): {c['text']}\nLATER ({m['ts']:%Y-%m-%d}): {m['text']}",
                      SCHEMA, "relation")
        out.append((c, r["relation"]))
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
