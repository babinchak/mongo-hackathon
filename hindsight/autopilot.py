"""Zero-human loop: raw agent history for a repo -> validated eval suite -> swept configs -> a
self-tuned memory harness. Stages skip work already done, except case generation, which adds
new cases from moments not used yet. Tuning runs over the validated cases of every repo.

uv run python -m hindsight.autopilot --repo FSM1/cipher-box [--cases 40] [--tune-rounds 5]

Needs the memory API running (uv run uvicorn hindsight.api:app --port 8000) for the sweep/tune.
"""
import argparse
import time

from hindsight import indexes
from hindsight.ingest import core as ingest
from hindsight.memory import configs
from hindsight.pipeline import cases, chat_only, link, mine, refine, sweep, tune, validate

BASE_CONFIGS = ["repo_only", "vector_turns", "hybrid_turns", "hybrid_all", "hybrid_all_brief", "ablate_superseded"]


def step(name, fn, *args, **kwargs):
    t = time.monotonic()
    print(f"\n== {name}")
    out = fn(*args, **kwargs)
    print(f"   ({time.monotonic() - t:.0f}s)")
    return out


def run(repo_id: str, n_cases: int = 40, tune_rounds: int = 5, workers: int = 24):
    step("ingest history into Atlas", ingest.run, repo_id)
    step("indexes", lambda: (indexes.regular_indexes(), indexes.search_indexes(), indexes.wait_ready()))
    step("harness configs", configs.seed)
    step("mine moments from developer pushback", mine.mine, repo_id)
    step("strict audit of moments", refine.refine, repo_id)
    step("link repeats and supersessions", link.link, repo_id)
    step("generate eval cases", cases.generate, repo_id, n_cases)
    step("drop cases the repo already answers", chat_only.run, repo_id)
    step("validate with pi (repo-only must fail, evidence must pass)", validate.run, repo_id)
    step("sweep harness configs", sweep.run, BASE_CONFIGS, [1, 7, 21], 3, repo_id, workers)
    step("self-tune the memory harness", tune.tune, tune_rounds, "hybrid_all_brief")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True)
    p.add_argument("--cases", type=int, default=40)
    p.add_argument("--tune-rounds", type=int, default=5)
    a = p.parse_args()
    run(a.repo, a.cases, a.tune_rounds)
