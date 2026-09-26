"""Re-judge stored runs with the current judge prompt (no new pi runs)."""
import argparse
from concurrent.futures import ThreadPoolExecutor

from hindsight.db import db
from hindsight.pipeline.evaluate import judge
from hindsight.pipeline.validate import summarize


def rejudge(phase: str, workers: int = 16):
    runs = list(db().runs.find({"phase": phase, "verdict": {"$in": ["pass", "fail"]}}))
    cases = {c["_id"]: c for c in db().cases.find({"_id": {"$in": list({r["case_id"] for r in runs})}})}

    def one(r):
        v = judge(cases[r["case_id"]], r["response"])
        db().runs.update_one({"_id": r["_id"]}, {"$set": {"verdict": v["verdict"], "reason": v["reason"],
                                                          "prev_verdict": r["verdict"]}})
        return r["verdict"], v["verdict"]

    with ThreadPoolExecutor(workers) as ex:
        changes = list(ex.map(one, runs))
    flips = sum(a != b for a, b in changes)
    print(f"re-judged {len(runs)} {phase} runs · {flips} verdicts changed")
    if phase == "validation":
        for repo in {c["repo_id"] for c in cases.values()}:
            summarize(repo)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--phase", default="validation")
    rejudge(p.parse_args().phase)
