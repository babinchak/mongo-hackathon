import argparse
from datetime import datetime

from hindsight.db import db
from hindsight.llm import embed


def counts(repo_id: str) -> tuple[datetime, datetime]:
    m = db().memory
    print(f"sessions: {db().sessions.count_documents({'repo_id': repo_id})}")
    group = [
        {"$match": {"repo_id": repo_id}},
        {"$group": {"_id": {"kind": "$kind", "role": "$role", "noise": "$noise"},
                    "n": {"$sum": 1},
                    "embedded": {"$sum": {"$cond": [{"$ifNull": ["$embedding", False]}, 1, 0]}}}},
        {"$sort": {"_id.kind": 1, "_id.role": 1, "_id.noise": 1}},
    ]
    for r in m.aggregate(group):
        print(f"  {r['_id']}: {r['n']} (embedded {r['embedded']})")
    pb = m.aggregate([
        {"$match": {"repo_id": repo_id, "role": "user"}},
        {"$group": {"_id": {"pushback": "$pushback", "noise": "$noise"}, "n": {"$sum": 1}}},
        {"$sort": {"_id.pushback": 1, "_id.noise": 1}},
    ])
    print("pushback x noise (user turns):")
    for r in pb:
        print(f"  {r['_id']}: {r['n']}")
    span = next(m.aggregate([
        {"$match": {"repo_id": repo_id}},
        {"$group": {"_id": None, "lo": {"$min": "$ts"}, "hi": {"$max": "$ts"},
                    "null_ts": {"$sum": {"$cond": [{"$eq": ["$ts", None]}, 1, 0]}}}},
    ]))
    print(f"ts range: {span['lo']} .. {span['hi']} (null ts: {span['null_ts']})")
    return span["lo"], span["hi"]


def show(label: str, docs: list[dict], cutoff: datetime) -> None:
    bad = [d for d in docs if d["ts"] >= cutoff]
    print(f"{label}: {len(docs)} results, {len(bad)} at/after cutoff -> {'OK' if not bad else 'LEAK'}")
    for d in docs[:3]:
        print(f"  {d['score']:.3f} {d['ts']:%Y-%m-%d %H:%M} [{d['role']}] {d['text'][:120]!r}")


def search_checks(repo_id: str, cutoff: datetime, query: str) -> None:
    m = db().memory
    project = {"text": 1, "ts": 1, "role": 1, "score": {"$meta": "searchScore"}}
    vec = list(m.aggregate([
        {"$vectorSearch": {
            "index": "memory_vec", "path": "embedding", "queryVector": embed([query])[0],
            "numCandidates": 200, "limit": 20,
            "filter": {"repo_id": repo_id, "ts": {"$lt": cutoff}, "noise": False},
        }},
        {"$project": {**project, "score": {"$meta": "vectorSearchScore"}}},
    ]))
    show(f"$vectorSearch '{query}' ts < {cutoff:%Y-%m-%d}", vec, cutoff)
    txt = list(m.aggregate([
        {"$search": {"index": "memory_text", "compound": {
            "must": [{"text": {"query": query, "path": "text"}}],
            "filter": [
                {"equals": {"path": "repo_id", "value": repo_id}},
                {"range": {"path": "ts", "lt": cutoff}},
                {"equals": {"path": "noise", "value": False}},
            ],
        }}},
        {"$limit": 20},
        {"$project": project},
    ]))
    show(f"$search '{query}' ts < {cutoff:%Y-%m-%d}", txt, cutoff)
    unfiltered = m.count_documents({"repo_id": repo_id, "noise": False, "ts": {"$gte": cutoff}})
    print(f"(non-noise docs at/after cutoff that must be excluded: {unfiltered})")


def main() -> None:
    p = argparse.ArgumentParser(prog="python -m hindsight.ingest.verify")
    p.add_argument("--repo", required=True)
    p.add_argument("--query", default="release process and CI e2e gating")
    args = p.parse_args()
    lo, hi = counts(args.repo)
    search_checks(args.repo, lo + (hi - lo) / 2, args.query)


if __name__ == "__main__":
    main()
