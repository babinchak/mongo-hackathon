"""Stage 7: every harness config x validated case x horizon x repeat."""
import argparse
from concurrent.futures import ThreadPoolExecutor

from hindsight.db import db
from hindsight.pipeline.evaluate import execute
from hindsight.snapshots import snapshot


def run(configs: list[str], horizons: list[int], repeats: int, repo_id: str | None = None, workers: int = 8,
        fresh_only: bool = False):
    q = {"status": {"$in": ["validated", "approved"]}}
    if repo_id:
        q["repo_id"] = repo_id
    cases = list(db().cases.find(q))
    if fresh_only:  # cases with no sweep runs yet (lets a second sweep run beside a live one)
        swept = set(db().runs.distinct("case_id", {"phase": "sweep"}))
        cases = [c for c in cases if c["_id"] not in swept]
    jobs = []
    for c in cases:
        for h in horizons:
            if not any(x["horizon_days"] == h for x in c["cutoffs"]):
                continue
            snapshot(c["repo_id"], next(x for x in c["cutoffs"] if x["horizon_days"] == h)["cutoff"])
            done = {(r["config_id"], r["repeat"]) for r in db().runs.find(
                {"case_id": c["_id"], "horizon_days": h, "phase": "sweep"}, {"config_id": 1, "repeat": 1})}
            jobs += [(c, cfg, h, r) for cfg in configs for r in range(repeats) if (cfg, r) not in done]
    print(f"sweep: {len(cases)} cases -> {len(jobs)} new pi runs")
    with ThreadPoolExecutor(workers) as ex:
        runs = list(ex.map(lambda j: execute(j[0], j[1], j[2], j[3], "sweep"), jobs))
    print(f"done · {sum(r['verdict'] == 'pass' for r in runs)}/{len(runs)} pass · "
          f"${sum(r['cost_usd'] or 0 for r in runs):.2f}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--configs", default="repo_only,hybrid_turns,hybrid_all,hybrid_all_brief")
    p.add_argument("--horizons", default="7")
    p.add_argument("--repeats", type=int, default=3)
    p.add_argument("--repo")
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--fresh-only", action="store_true")
    a = p.parse_args()
    run(a.configs.split(","), [int(h) for h in a.horizons.split(",")], a.repeats, a.repo, a.workers, a.fresh_only)
