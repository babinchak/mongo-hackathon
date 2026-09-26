from hindsight.db import db

CONFIGS = [
    {"_id": "repo_only", "label": "Repo only (no memory)", "memory": False},
    {"_id": "vector_turns", "label": "Vector · raw turns", "memory": True, "retrieval": "vector",
     "source": "turns", "k": 8, "briefing": False, "drop_superseded": True, "recency_weight": 0.0},
    {"_id": "hybrid_turns", "label": "Hybrid · raw turns", "memory": True, "retrieval": "hybrid",
     "source": "turns", "k": 8, "briefing": False, "drop_superseded": True, "recency_weight": 0.0},
    {"_id": "hybrid_all", "label": "Hybrid · moments + turns", "memory": True, "retrieval": "hybrid",
     "source": "moments+turns", "k": 8, "briefing": False, "drop_superseded": True, "recency_weight": 0.0},
    {"_id": "hybrid_all_brief", "label": "Hybrid · moments + turns · briefing", "memory": True,
     "retrieval": "hybrid", "source": "moments+turns", "k": 8, "briefing": True,
     "drop_superseded": True, "recency_weight": 0.0},
    {"_id": "ablate_superseded", "label": "Hybrid + briefing, keep superseded", "memory": True,
     "retrieval": "hybrid", "source": "moments+turns", "k": 8, "briefing": True,
     "drop_superseded": False, "recency_weight": 0.0},
]


def seed():
    for c in CONFIGS:
        db().harness_configs.replace_one({"_id": c["_id"]}, c, upsert=True)


def get(config_id: str) -> dict:
    c = db().harness_configs.find_one({"_id": config_id})
    if c is None:
        c = next((c for c in CONFIGS if c["_id"] == config_id), None)
    if c is None:
        raise KeyError(config_id)
    return c


if __name__ == "__main__":
    seed()
    print("seeded", [c["_id"] for c in CONFIGS])
