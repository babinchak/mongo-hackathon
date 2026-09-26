"""Self-tuning memory harness: an LLM reads failures, proposes a new harness config, keeps it only
if it beats the incumbent on the DEV split (earlier cutoffs), and the winner is reported on the
held-out TEST split (later cutoffs).

uv run python -m hindsight.pipeline.tune --rounds 5 --start hybrid_all
"""
import argparse
import json
import os
import random
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from hindsight.db import db
from hindsight.llm import chat_json
from hindsight.memory import configs
from hindsight.pipeline.evaluate import execute

KNOBS = {
    "retrieval": ["vector", "bm25", "hybrid"],
    "source": ["turns", "moments", "moments+turns"],
    "k": [4, 8, 12, 16],
    "briefing": [True, False],
    "briefing_k": [4, 8, 12],
    "drop_superseded": [True, False],
    "recency_weight": [0.0, 0.2, 0.5],
    "framing": ["notes", "rules"],
    "nudge": ["none", "search_first", "restate"],
}
KNOB_HELP = """- retrieval: how search_memory ranks (vector / bm25 keyword / hybrid fusion)
- source: what memory holds: raw chat turns, mined moments (one-sentence rules), or both
- k: results per search_memory call
- briefing: inject a briefing of relevant decisions/constraints into the system prompt up front
- briefing_k: number of briefing items
- drop_superseded: hide decisions that a later decision replaced (as of the cutoff)
- recency_weight: boost newer memories (0 = off)
- framing: present memory as "notes" or as "rules" (binding, overrides conventions in the code)
- nudge: system-prompt instruction: none / search_first (call search_memory before planning) /
  restate (search first, then quote the applicable rules before the plan)"""

SYSTEM = f"""You tune the memory harness of a coding agent (pi). Each harness config is a set of knob \
values. The agent runs on eval cases mined from real development history: each case needs one piece \
of knowledge the developer told an agent in an earlier session. You see the scores of configs tried \
so far and a sample of failures of the current best config, including whether memory retrieved the \
gold evidence (retrieval failure vs. the agent ignoring retrieved memory).

Knobs:
{KNOB_HELP}

Propose ONE new config that you expect to score higher. Change the knobs that address the observed \
failure mode; don't repeat a config already tried. Explain the hypothesis in 1-2 sentences."""

SCHEMA = {
    "type": "object",
    "properties": {
        "hypothesis": {"type": "string"},
        **{k: {"type": "string" if isinstance(v[0], str) else ("boolean" if isinstance(v[0], bool) else "number")}
           for k, v in KNOBS.items()},
    },
    "required": ["hypothesis", *KNOBS],
    "additionalProperties": False,
}


def _unit(case):
    """The (case, cutoff) unit used for tuning: the 7-day horizon, else the first available."""
    return next((c["horizon_days"] for c in case["cutoffs"] if c["horizon_days"] == 7), case["cutoffs"][0]["horizon_days"])


def split():
    cases = sorted(db().cases.find({"status": {"$in": ["validated", "approved"]}}), key=lambda c: c["cutoffs"][0]["cutoff"])
    mid = len(cases) // 2
    return cases[:mid], cases[mid:]


def evaluate(config_id, cases, repeats=3, phase="tune", workers=24):
    """Score a config on cases; reuses existing sweep/tune runs for the same unit."""
    jobs, runs = [], []
    for c in cases:
        h = _unit(c)
        have = list(db().runs.find({"case_id": c["_id"], "config_id": config_id, "horizon_days": h,
                                    "phase": {"$in": ["sweep", "tune", "tune_test"]}, "verdict": {"$in": ["pass", "fail"]}}))
        runs += have[:repeats]
        jobs += [(c, h, r) for r in range(len(have), repeats)]
    with ThreadPoolExecutor(workers) as ex:
        runs += list(ex.map(lambda j: execute(j[0], config_id, j[1], j[2], phase), jobs))
    graded = [r for r in runs if r["verdict"] in ("pass", "fail")]
    return {
        "pass_at_1": sum(r["verdict"] == "pass" for r in graded) / max(len(graded), 1),
        "evidence_recall": sum(bool(r.get("hit_gold")) for r in graded) / max(len(graded), 1),
        "n_runs": len(graded), "new_runs": len(jobs), "runs": graded,
    }


def _failures(result, cases, n=8):
    by_id = {c["_id"]: c for c in cases}
    fails = [r for r in result["runs"] if r["verdict"] == "fail"]
    random.shuffle(fails)
    return [{"task": by_id[r["case_id"]]["task"][:400], "expected": by_id[r["case_id"]]["expected"][:300],
             "judge_reason": r["reason"][:300], "memory_retrieved_gold": r.get("hit_gold"),
             "called_search_memory": r.get("used_memory_tool")} for r in fails[:n]]


def propose(history, failures):
    tried = [{"config": {k: h["config"].get(k) for k in KNOBS}, "dev_pass_at_1": round(h["dev"]["pass_at_1"], 3),
              "dev_evidence_recall": round(h["dev"]["evidence_recall"], 3)} for h in history]
    user = (f"CONFIGS TRIED (dev split):\n{json.dumps(tried, indent=1)}\n\n"
            f"SAMPLE FAILURES OF THE CURRENT BEST:\n{json.dumps(failures, indent=1)}")
    out = chat_json(os.environ.get("TUNE_MODEL", "gpt-6-astra"), SYSTEM, user, SCHEMA, "harness_config")
    cfg = {}
    for k, allowed in KNOBS.items():
        v = out[k]
        if isinstance(allowed[0], bool):
            cfg[k] = bool(v)
        elif isinstance(allowed[0], (int, float)):
            cfg[k] = min(allowed, key=lambda a: abs(a - v))  # snap to the nearest allowed value
        else:
            cfg[k] = v if v in allowed else allowed[0]
    return cfg, out["hypothesis"]


def tune(rounds=5, start="hybrid_all"):
    dev, test = split()
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    print(f"tune {run_id}: dev {len(dev)} cases, test {len(test)} cases")
    base = configs.get(start)
    history = [{"config_id": start, "config": base, "hypothesis": "starting point",
                "dev": evaluate(start, dev)}]
    best = history[0]
    print(f"  {start}: dev pass@1 {best['dev']['pass_at_1']:.3f}")
    doc = {"_id": f"tune:{run_id}", "start": start, "dev_cases": [c["_id"] for c in dev],
           "test_cases": [c["_id"] for c in test], "created_at": datetime.now(timezone.utc)}

    def save(status):
        db().tuning.replace_one({"_id": doc["_id"]}, {**doc, "status": status, "best": best["config_id"], "steps": [
            {"config_id": h["config_id"], "config": {k: h["config"].get(k) for k in KNOBS}, "hypothesis": h["hypothesis"],
             "dev_pass_at_1": h["dev"]["pass_at_1"], "dev_evidence_recall": h["dev"]["evidence_recall"],
             "dev_runs": h["dev"]["n_runs"], "accepted": h.get("accepted", h is history[0])} for h in history],
            **({"test": doc["test"]} if "test" in doc else {})}, upsert=True)

    save("running")
    for i in range(1, rounds + 1):
        cfg, hypothesis = propose(history, _failures(best["dev"], dev))
        cid = f"tuned_{run_id}_{i}"
        db().harness_configs.replace_one({"_id": cid}, {
            "_id": cid, "label": f"Tuned #{i}", "memory": True, "tuned": True, "hypothesis": hypothesis, **cfg}, upsert=True)
        step = {"config_id": cid, "config": cfg, "hypothesis": hypothesis, "dev": evaluate(cid, dev)}
        step["accepted"] = step["dev"]["pass_at_1"] > best["dev"]["pass_at_1"]
        history.append(step)
        if step["accepted"]:
            best = step
        print(f"  round {i}: {cid} dev pass@1 {step['dev']['pass_at_1']:.3f} "
              f"({'ACCEPT' if step['accepted'] else 'reject'}): {hypothesis}")
        save("running")

    doc["test"] = {cid: {k: v for k, v in evaluate(cid, test, phase="tune_test").items() if k != "runs"}
                   for cid in dict.fromkeys(["repo_only", start, best["config_id"]])}
    save("done")
    for cid, t in doc["test"].items():
        print(f"  TEST {cid}: pass@1 {t['pass_at_1']:.3f} recall {t['evidence_recall']:.3f} (n={t['n_runs']})")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--rounds", type=int, default=5)
    p.add_argument("--start", default="hybrid_all")
    a = p.parse_args()
    tune(a.rounds, a.start)
