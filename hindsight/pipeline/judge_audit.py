"""Re-grade a random sample of sweep runs with a stronger judge and report agreement."""
import argparse
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from hindsight.db import db
from hindsight.pipeline import evaluate


def audit(n: int = 50, model: str = "gpt-6-astra", workers: int = 8):
    runs = list(db().runs.aggregate([{"$match": {"phase": "sweep", "verdict": {"$in": ["pass", "fail"]}}},
                                     {"$sample": {"size": n}}]))
    cases = {c["_id"]: c for c in db().cases.find({"_id": {"$in": list({r["case_id"] for r in runs})}})}
    base = os.environ.get("JUDGE_MODEL")
    os.environ["JUDGE_MODEL"] = model
    try:
        with ThreadPoolExecutor(workers) as ex:
            second = list(ex.map(lambda r: evaluate.judge(cases[r["case_id"]], r["response"]), runs))
    finally:
        os.environ["JUDGE_MODEL"] = base or ""
    agree = sum(r["verdict"] == s["verdict"] for r, s in zip(runs, second))
    doc = {"_id": f"judge_audit:{datetime.now(timezone.utc):%Y%m%dT%H%M%S}", "judge": base, "auditor": model,
           "n": len(runs), "agree": agree, "agreement": agree / max(len(runs), 1),
           "disagreements": [{"run_id": r["_id"], "case_id": r["case_id"], "judge": r["verdict"],
                              "auditor": s["verdict"], "auditor_reason": s["reason"]}
                             for r, s in zip(runs, second) if r["verdict"] != s["verdict"]],
           "created_at": datetime.now(timezone.utc)}
    db().audits.insert_one(doc)
    print(f"{base} vs {model}: agree {agree}/{len(runs)} ({doc['agreement']:.0%})")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("-n", type=int, default=50)
    p.add_argument("--model", default="gpt-6-astra")
    a = p.parse_args()
    audit(a.n, a.model)
