import os
from datetime import datetime, timezone

import duckdb
from pymongo import UpdateOne

from hindsight.db import db
from hindsight.ingest.noise import is_noise
from hindsight.llm import embed

FOREVER = datetime(9999, 12, 31)
TEXT_CAP = 8000
ROLES = {"user_prompt": "user", "assistant_response": "assistant"}
PUSHBACK = {"correction", "failure_report", "rejection", "takeover"}


def _data_dir() -> str:
    return os.environ.get("SWE_CHAT_DIR", "/Users/conner/data/swe-chat")


def _ms(v) -> datetime | None:
    return None if v is None else datetime.fromtimestamp(v / 1000, tz=timezone.utc)


def load(repo_id: str) -> tuple[list[dict], list[dict]]:
    d = _data_dir()
    con = duckdb.connect()
    sessions = con.execute(
        f"""select session_id, agent, branch, prompt_count, epoch_ms(created_at)
            from '{d}/sessions.parquet' where repo_id = ? order by created_at""",
        [repo_id],
    ).fetchall()
    turns = con.execute(
        f"""select turn_id, session_id, turn_type, content, prompt_pushback, epoch_ms(timestamp)
            from '{d}/conversations.parquet'
            where repo_id = ? and turn_type in ('user_prompt', 'assistant_response')
            order by session_id, turn_number""",
        [repo_id],
    ).fetchall()

    session_docs = {}
    for sid, agent, branch, prompts, created in sessions:
        session_docs[sid] = {
            "_id": sid, "repo_id": repo_id, "started_at": _ms(created),
            "agent": agent, "prompts": prompts, "branch": branch,
        }

    # created_at is recorded near the END of a session, so leading turns without a timestamp
    # take the session's first known turn timestamp; created_at is only the last resort.
    first_ts = {}
    for _, sid, _, _, _, ts_ms in turns:
        if ts_ms is not None and sid not in first_ts:
            first_ts[sid] = _ms(ts_ms)
    for sid, s in session_docs.items():
        if sid in first_ts and (s["started_at"] is None or first_ts[sid] < s["started_at"]):
            s["started_at"] = first_ts[sid]

    turn_docs = []
    seq, last_ts, current = 0, None, None
    for tid, sid, turn_type, content, pushback, ts_ms in turns:
        if sid != current:
            current, seq = sid, 0
            last_ts = first_ts.get(sid) or session_docs.get(sid, {}).get("started_at")
        ts = _ms(ts_ms) or last_ts
        last_ts = ts
        role = ROLES[turn_type]
        content = content or ""
        turn_docs.append({
            "_id": tid, "kind": "turn", "repo_id": repo_id, "session_id": sid, "seq": seq,
            "ts": ts, "text": content[:TEXT_CAP], "role": role,
            "pushback": pushback if role == "user" and pushback in PUSHBACK else None,
            "noise": is_noise(role, content),
            "durable": False, "superseded_at": FOREVER,
        })
        seq += 1
    return list(session_docs.values()), turn_docs


def write(sessions: list[dict], turns: list[dict], chunk: int = 1000) -> None:
    ops = [UpdateOne({"_id": s["_id"]}, {"$set": s}, upsert=True) for s in sessions]
    if ops:
        db().sessions.bulk_write(ops, ordered=False)
    for i in range(0, len(turns), chunk):
        ops = []
        for t in turns[i : i + chunk]:
            update = {"$set": t}
            if t["noise"]:
                update["$unset"] = {"embedding": ""}
            ops.append(UpdateOne({"_id": t["_id"]}, update, upsert=True))
        db().memory.bulk_write(ops, ordered=False)


def embed_missing(repo_id: str, batch: int = 256) -> int:
    todo = list(db().memory.find(
        {"repo_id": repo_id, "kind": "turn", "noise": False, "embedding": {"$exists": False}},
        {"text": 1},
    ))
    for i in range(0, len(todo), batch):
        chunk = todo[i : i + batch]
        vectors = embed([d["text"] for d in chunk], batch=batch)
        db().memory.bulk_write(
            [UpdateOne({"_id": d["_id"]}, {"$set": {"embedding": v}}) for d, v in zip(chunk, vectors)],
            ordered=False,
        )
        print(f"  embedded {min(i + batch, len(todo))}/{len(todo)}")
    return len(todo)


def run(repo_id: str, do_embed: bool = True) -> None:
    sessions, turns = load(repo_id)
    if not turns:
        raise SystemExit(f"no turns found for {repo_id}")
    users = [t for t in turns if t["role"] == "user"]
    print(f"{repo_id}: {len(sessions)} sessions, {len(turns)} turns "
          f"({len(users)} user, {sum(t['noise'] for t in users)} user noise, "
          f"{sum(t['noise'] for t in turns) - sum(t['noise'] for t in users)} assistant noise)")
    write(sessions, turns)
    print("  upserted sessions + turns")
    if do_embed:
        n = embed_missing(repo_id)
        print(f"  embedded {n} new turns")
