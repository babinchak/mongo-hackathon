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
    cost = sum(r["cost_usd"] or 0 for r in runs)
    kept = 0
    for c in cases:
        mine = [r for r in runs if r["case_id"] == c["_id"]]
        v = {cfg: [r["verdict"] for r in mine if r["config_id"] == cfg] for cfg in ("repo_only", "oracle")}
        ok = all(x == "fail" for x in v["repo_only"]) and all(x == "pass" for x in v["oracle"])
        kept += ok
        db().cases.update_one({"_id": c["_id"]}, {"$set": {"validation": v, "status": "validated" if ok else "rejected"}})
        print(("KEEP " if ok else "drop ") + c["_id"], v)
    print(f"validated {kept}/{len(cases)} · pi cost ${cost:.2f}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True)
    p.add_argument("--repeats", type=int, default=2)
    p.add_argument("--limit", type=int)
    a = p.parse_args()
    run(a.repo, a.repeats, a.limit)
