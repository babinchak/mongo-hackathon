"""Stage 6: keep cases where pi with only the repo FAILS and pi with the gold evidence PASSES."""
import argparse
from concurrent.futures import ThreadPoolExecutor

from hindsight.db import db
from hindsight.pipeline.evaluate import execute
from hindsight.snapshots import snapshot


def run(repo_id: str, repeats: int = 2, limit: int | None = None, workers: int = 8):
    q = {"repo_id": repo_id, "chat_only": True, "status": "generated"}
    cases = list(db().cases.find(q).limit(limit or 0))
    for c in cases:  # warm snapshots serially; git work isn't thread-safe
        snapshot(repo_id, c["cutoffs"][0]["cutoff"])
    jobs = [(c, cfg, r) for c in cases for cfg in ("repo_only", "oracle") for r in range(repeats)]
    print(f"{repo_id}: validating {len(cases)} cases ({len(jobs)} pi runs)")
    with ThreadPoolExecutor(workers) as ex:
        runs = list(ex.map(lambda j: execute(j[0], j[1], repeat=j[2], phase="validation"), jobs))
    print(f"pi cost ${sum(r['cost_usd'] or 0 for r in runs):.2f}")
    summarize(repo_id)


def summarize(repo_id: str):
    """Recompute each case's validation from its stored validation runs."""
    q = {"repo_id": repo_id, "status": {"$in": ["generated", "validated", "rejected"]}, "chat_only": True}
    kept = total = 0
    for c in db().cases.find(q):
        runs = list(db().runs.find({"case_id": c["_id"], "phase": "validation"}))
        if not runs:
            continue
        v = {cfg: [r["verdict"] for r in runs if r["config_id"] == cfg] for cfg in ("repo_only", "oracle")}
        repo_fails = bool(v["repo_only"]) and all(x == "fail" for x in v["repo_only"])
        oracle_passes = v["oracle"].count("pass")
        ok = repo_fails and oracle_passes > 0
        strength = "strong" if ok and oracle_passes == len(v["oracle"]) else ("weak" if ok else None)
        kept += ok
        total += 1
        db().cases.update_one({"_id": c["_id"]}, {"$set": {
            "validation": v, "validation_strength": strength, "status": "validated" if ok else "rejected"}})
    print(f"{repo_id}: validated {kept}/{total}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True)
    p.add_argument("--repeats", type=int, default=2)
    p.add_argument("--limit", type=int)
    a = p.parse_args()
    run(a.repo, a.repeats, a.limit)
