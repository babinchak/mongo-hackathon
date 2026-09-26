from datetime import datetime

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from hindsight.db import db
from hindsight.memory import configs, search as mem

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
