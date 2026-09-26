"""Leaderboard + funnel computed with MongoDB aggregations."""
from hindsight.db import db


def _per_case(match: dict, extra_key: str | None = None) -> list[dict]:
    key = {"config_id": "$config_id", "case_id": "$case_id"}
    if extra_key:
        key[extra_key] = f"${extra_key}"
    return [
        {"$match": {"phase": "sweep", "verdict": {"$in": ["pass", "fail"]}, **match}},
        {"$group": {"_id": key, "runs": {"$sum": 1},
                    "passes": {"$sum": {"$cond": [{"$eq": ["$verdict", "pass"]}, 1, 0]}},
                    "hit_gold": {"$avg": {"$cond": ["$hit_gold", 1, 0]}},
                    "tool_use": {"$avg": {"$cond": ["$used_memory_tool", 1, 0]}},
                    "cost": {"$sum": "$cost_usd"}}},
        {"$addFields": {"pass_rate": {"$divide": ["$passes", "$runs"]},
                        "all_pass": {"$cond": [{"$eq": ["$passes", "$runs"]}, 1, 0]}}},
    ]


def _rollup(group_id) -> list[dict]:
    return [
        {"$group": {"_id": group_id, "n_cases": {"$sum": 1}, "n_runs": {"$sum": "$runs"},
                    "pass_at_1": {"$avg": "$pass_rate"}, "pass_pow_3": {"$avg": "$all_pass"},
                    "evidence_recall": {"$avg": "$hit_gold"}, "memory_tool_use": {"$avg": "$tool_use"},
                    "cost": {"$sum": "$cost"}}},
    ]


def leaderboard(repo_id: str | None = None) -> list[dict]:
    match = {}
    if repo_id:
        match["case_id"] = {"$in": [c["_id"] for c in db().cases.find({"repo_id": repo_id}, {"_id": 1})]}
    runs = db().runs
    overall = list(runs.aggregate(_per_case(match) + _rollup("$_id.config_id")))
    by_h = list(runs.aggregate(_per_case(match, "horizon_days") +
                               _rollup({"config_id": "$_id.config_id", "h": "$_id.horizon_days"})))
    by_s = list(runs.aggregate(_per_case(match) + [
        {"$lookup": {"from": "cases", "localField": "_id.case_id", "foreignField": "_id", "as": "case"}},
        {"$set": {"scenario": {"$first": "$case.scenario"}}},
    ] + _rollup({"config_id": "$_id.config_id", "s": "$scenario"})))
    labels = {c["_id"]: c.get("label", c["_id"]) for c in db().harness_configs.find()}
    out = []
    for row in overall:
        cid = row["_id"]
        out.append({
            "config_id": cid, "label": labels.get(cid, cid), "n_cases": row["n_cases"], "n_runs": row["n_runs"],
            "pass_at_1": row["pass_at_1"], "pass_pow_3": row["pass_pow_3"],
            "evidence_recall": row["evidence_recall"], "memory_tool_use": row["memory_tool_use"],
            "cost_usd_per_run": row["cost"] / max(row["n_runs"], 1),
            "by_horizon": {str(r["_id"]["h"]): {"pass_at_1": r["pass_at_1"], "pass_pow_3": r["pass_pow_3"], "n_cases": r["n_cases"]}
                           for r in by_h if r["_id"]["config_id"] == cid},
            "by_scenario": {r["_id"]["s"]: {"pass_at_1": r["pass_at_1"], "pass_pow_3": r["pass_pow_3"], "n_cases": r["n_cases"]}
                            for r in by_s if r["_id"]["config_id"] == cid},
        })
    return sorted(out, key=lambda r: r["pass_at_1"], reverse=True)


def funnel(repo_id: str | None = None) -> dict:
    m = {"repo_id": repo_id} if repo_id else {}
    mem, cases = db().memory, db().cases
    return {
        "events": mem.count_documents({**m, "kind": "turn"}),
        "pushback": mem.count_documents({**m, "kind": "turn", "role": "user", "noise": False, "pushback": {"$ne": None}}),
        "durable_moments": mem.count_documents({**m, "kind": "moment", "durable": True}),
        "cases": cases.count_documents(m),
        "chat_only": cases.count_documents({**m, "chat_only": True}),
        "validated": cases.count_documents({**m, "status": {"$in": ["validated", "approved"]}}),
        "approved": cases.count_documents({**m, "status": "approved"}),
    }
