"""Cutoff-bounded memory retrieval over the `memory` collection.

Every query filters repo_id and ts < cutoff inside Atlas, for vector and text search alike.
"""
import math
from datetime import datetime, timezone

from hindsight.db import db
from hindsight.llm import embed
from hindsight.memory import configs

RRF_K = 60
FAR = datetime(9999, 12, 31, tzinfo=timezone.utc)
BRIEF_KINDS = ["constraint", "decision", "procedure", "failed_approach"]
PROJECT = {"embedding": 0}


def _vector(qv, repo_id, cutoff, kind, k, drop_superseded, moment_kinds=None):
    f = [{"repo_id": repo_id}, {"ts": {"$lt": cutoff}}, {"kind": kind}]
    if kind == "moment":
        f.append({"durable": True})
        if drop_superseded:
            f.append({"superseded_at": {"$gte": cutoff}})
    if moment_kinds:
        f.append({"moment_kind": {"$in": moment_kinds}})
    pipeline = [
        {"$vectorSearch": {"index": "memory_vec", "path": "embedding", "queryVector": qv,
                           "numCandidates": max(150, k * 20), "limit": k, "filter": {"$and": f}}},
        {"$project": {**PROJECT, "score": {"$meta": "vectorSearchScore"}}},
    ]
    return list(db().memory.aggregate(pipeline))


def _text(query, repo_id, cutoff, kind, k, drop_superseded, moment_kinds=None):
    f = [{"equals": {"path": "repo_id", "value": repo_id}},
         {"range": {"path": "ts", "lt": cutoff}},
         {"equals": {"path": "kind", "value": kind}}]
    if kind == "moment":
        f.append({"equals": {"path": "durable", "value": True}})
        if drop_superseded:
            f.append({"range": {"path": "superseded_at", "gte": cutoff}})
    if moment_kinds:
        f.append({"in": {"path": "moment_kind", "value": moment_kinds}})
    pipeline = [
        {"$search": {"index": "memory_text", "compound": {
            "must": [{"text": {"query": query, "path": "text"}}],
            "filter": f,
            "mustNot": [{"equals": {"path": "noise", "value": True}}]}}},
        {"$limit": k},
        {"$project": {**PROJECT, "score": {"$meta": "searchScore"}}},
    ]
    return list(db().memory.aggregate(pipeline))


def _fuse(lists: list[list[dict]], k: int) -> list[dict]:
    """Reciprocal rank fusion ($rankFusion needs MongoDB 8.1; the sandbox runs 8.0)."""
    docs, scores = {}, {}
    for lst in lists:
        for rank, d in enumerate(lst):
            docs.setdefault(d["_id"], d)
            scores[d["_id"]] = scores.get(d["_id"], 0.0) + 1.0 / (RRF_K + rank + 1)
    ranked = sorted(scores, key=scores.get, reverse=True)[:k]
    return [{**docs[i], "score": scores[i]} for i in ranked]


def _recency(items, cutoff, weight):
    if not weight or not items:
        return items
    top = max(d["score"] for d in items) or 1.0
    for d in items:
        age_days = (cutoff - _aware(d["ts"])).total_seconds() / 86400
        d["score"] = (1 - weight) * d["score"] / top + weight * math.exp(-age_days / 30)
    return sorted(items, key=lambda d: d["score"], reverse=True)


def _retrieve(query, qv, repo_id, cutoff, kind, k, cfg, moment_kinds=None):
    drop = cfg.get("drop_superseded", True)
    mode = cfg.get("retrieval", "hybrid")
    if mode == "vector":
        items = _vector(qv, repo_id, cutoff, kind, k, drop, moment_kinds)
    elif mode == "bm25":
        items = _text(query, repo_id, cutoff, kind, k, drop, moment_kinds)
    else:
        items = _fuse([_vector(qv, repo_id, cutoff, kind, k * 2, drop, moment_kinds),
                       _text(query, repo_id, cutoff, kind, k * 2, drop, moment_kinds)], k)
    return _recency(items, cutoff, cfg.get("recency_weight", 0.0))


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _out(d: dict) -> dict:
    item = {"id": d["_id"], "kind": d["kind"], "ts": _aware(d["ts"]).isoformat().replace("+00:00", "Z"),
            "session_id": d.get("session_id"), "text": d.get("text", ""), "score": round(d["score"], 4)}
    if d["kind"] == "moment":
        item |= {"moment_kind": d.get("moment_kind"), "topic": d.get("topic"),
                 "source_turn_id": d.get("source_turn_id")}
    else:
        item["role"] = d.get("role")
    return item


def search(repo_id: str, cutoff: datetime, query: str, config_id: str, k: int | None = None) -> list[dict]:
    cfg = configs.get(config_id)
    if not cfg.get("memory"):
        return []
    cutoff = _aware(cutoff)
    k = k or cfg.get("k", 8)
    source = cfg.get("source", "moments+turns")
    qv = embed([query])[0] if cfg.get("retrieval", "hybrid") != "bm25" else None
    moments, turns = [], []
    if "moments" in source:
        moments = _retrieve(query, qv, repo_id, cutoff, "moment", k, cfg)
    if "turns" in source:
        turns = _retrieve(query, qv, repo_id, cutoff, "turn", k, cfg)
        turns = [t for t in turns if t.get("_id") not in {m.get("source_turn_id") for m in moments}]
    return [_out(d) for d in moments + turns][: k + len(moments)]


def briefing(repo_id: str, cutoff: datetime, query: str, config_id: str, k: int | None = None) -> dict:
    cfg = configs.get(config_id)
    k = k or cfg.get("briefing_k", 8)
    if not cfg.get("memory"):
        return {"text": "", "ids": []}
    cutoff = _aware(cutoff)
    qv = embed([query])[0]
    items = _retrieve(query, qv, repo_id, cutoff, "moment", k, {**cfg, "retrieval": "hybrid"},
                      moment_kinds=BRIEF_KINDS)
    if not items:
        return {"text": "", "ids": []}
    lines = [f"- [{_aware(d['ts']):%Y-%m-%d} · {d.get('moment_kind')} · {d.get('topic') or 'general'}] {d['text']}"
             for d in items]
    if cfg.get("framing", "notes") == "rules":
        head = (f"## Binding project rules (decided by the developer in earlier sessions, as of {cutoff:%Y-%m-%d}; "
                "they override conventions inferred from the code)\n")
    else:
        head = f"## Project memory (decisions and constraints from earlier sessions, as of {cutoff:%Y-%m-%d})\n"
    text = head + "\n".join(lines)
    return {"text": text, "ids": [d["_id"] for d in items]}
