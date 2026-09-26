from datetime import datetime

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from hindsight.db import db
from hindsight.memory import configs, search as mem, stats
from hindsight.pipeline.evaluate import execute

app = FastAPI(title="Hindsight")


class MemoryQuery(BaseModel):
    repo_id: str
    cutoff: datetime
    query: str
    config_id: str = "hybrid_all_brief"
    k: int | None = None


@app.post("/api/memory/search")
def memory_search(q: MemoryQuery):
    return {"items": mem.search(q.repo_id, q.cutoff, q.query, q.config_id, q.k)}


@app.post("/api/memory/briefing")
def memory_briefing(q: MemoryQuery):
    return mem.briefing(q.repo_id, q.cutoff, q.query, q.config_id)


@app.get("/api/configs")
def list_configs():
    return list(db().harness_configs.find())


@app.get("/api/configs/{config_id}")
def get_config(config_id: str):
    try:
        return configs.get(config_id)
    except KeyError:
        raise HTTPException(404, f"unknown config {config_id}")


@app.get("/api/leaderboard")
def get_leaderboard(repo_id: str | None = None):
    return stats.leaderboard(repo_id)


@app.get("/api/funnel")
def get_funnel(repo_id: str | None = None):
    return stats.funnel(repo_id)


@app.get("/api/cases")
def list_cases(repo_id: str | None = None, status: str | None = None):
    q = {k: v for k, v in {"repo_id": repo_id, "status": status}.items() if v}
    cases = list(db().cases.find(q))
    rates = {}
    for r in db().runs.aggregate([
        {"$match": {"case_id": {"$in": [c["_id"] for c in cases]}, "phase": "sweep", "verdict": {"$in": ["pass", "fail"]}}},
        {"$group": {"_id": {"case": "$case_id", "config": "$config_id"},
                    "rate": {"$avg": {"$cond": [{"$eq": ["$verdict", "pass"]}, 1, 0]}}}},
    ]):
        rates.setdefault(r["_id"]["case"], {})[r["_id"]["config"]] = r["rate"]
    for c in cases:
        c["summary"] = rates.get(c["_id"], {})
    return cases


@app.get("/api/cases/{case_id:path}")
def get_case(case_id: str):
    case = db().cases.find_one({"_id": case_id})
    if not case:
        raise HTTPException(404, "unknown case")
    moment = db().memory.find_one({"_id": case["moment_id"]}, {"embedding": 0})
    src = db().memory.find_one({"_id": moment["source_turn_id"]}, {"session_id": 1, "seq": 1}) if moment else None
    turns = []
    if src:
        turns = list(db().memory.find(
            {"session_id": src["session_id"], "kind": "turn", "noise": False, "seq": {"$gte": src["seq"] - 4, "$lte": src["seq"] + 2}},
            {"embedding": 0}).sort("seq", 1))
    runs = list(db().runs.find({"case_id": case_id}).sort("created_at", 1))
    return {"case": case, "moment": moment, "source_turns": turns, "runs": runs}


class Review(BaseModel):
    verdict: str
    reason: str = ""


@app.post("/api/cases/{case_id:path}/review")
def review_case(case_id: str, r: Review):
    status = "approved" if r.verdict == "approve" else "rejected"
    db().cases.update_one({"_id": case_id}, {"$set": {"review": r.model_dump(), "status": status}})
    return {"ok": True, "status": status}


class RunRequest(BaseModel):
    case_id: str
    config_id: str
    horizon_days: int | None = None


@app.post("/api/runs")
def run_now(req: RunRequest):
    case = db().cases.find_one({"_id": req.case_id})
    if not case:
        raise HTTPException(404, "unknown case")
    return execute(case, req.config_id, req.horizon_days, repeat=-1, phase="live")
