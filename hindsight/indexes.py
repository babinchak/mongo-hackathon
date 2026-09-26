import time

from pymongo import ASCENDING
from pymongo.operations import SearchIndexModel

from hindsight.db import db

VEC = {
    "fields": [
        {"type": "vector", "path": "embedding", "numDimensions": 512, "similarity": "cosine"},
        *({"type": "filter", "path": p}
          for p in ("repo_id", "ts", "kind", "durable", "superseded_at", "noise")),
    ]
}

TEXT = {
    "mappings": {
        "dynamic": False,
        "fields": {
            "text": {"type": "string", "analyzer": "lucene.english"},
            "repo_id": {"type": "token"},
            "kind": {"type": "token"},
            "ts": {"type": "date"},
            "superseded_at": {"type": "date"},
            "durable": {"type": "boolean"},
            "noise": {"type": "boolean"},
        },
    }
}

SEARCH_INDEXES = [("memory_vec", "vectorSearch", VEC), ("memory_text", "search", TEXT)]


def regular_indexes() -> None:
    d = db()
    d.memory.create_index([("repo_id", ASCENDING), ("ts", ASCENDING)])
    d.memory.create_index([("session_id", ASCENDING), ("seq", ASCENDING)])
    d.cases.create_index([("repo_id", ASCENDING), ("status", ASCENDING)])
    d.runs.create_index([("case_id", ASCENDING), ("config_id", ASCENDING)])
    print("regular indexes ok")


def search_indexes() -> None:
    d = db()
    if "memory" not in d.list_collection_names():
        d.create_collection("memory")
    existing = {i["name"]: i for i in d.memory.list_search_indexes()}
    for name, kind, definition in SEARCH_INDEXES:
        if name not in existing:
            d.memory.create_search_index(SearchIndexModel(definition=definition, name=name, type=kind))
            print(f"{name}: created")
        elif existing[name].get("latestDefinition") != definition:
            d.memory.update_search_index(name, definition)
            print(f"{name}: updated")
        else:
            print(f"{name}: unchanged")


def wait_ready(timeout_s: int = 600) -> None:
    names = [n for n, _, _ in SEARCH_INDEXES]
    start = time.time()
    while True:
        status = {i["name"]: i for i in db().memory.list_search_indexes() if i["name"] in names}
        line = ", ".join(f"{n}={status[n].get('status')} queryable={status[n].get('queryable')}"
                         for n in names if n in status)
        print(f"  [{int(time.time() - start)}s] {line}")
        if all(n in status and status[n].get("status") == "READY" and status[n].get("queryable")
               for n in names):
            return
        if time.time() - start > timeout_s:
            raise TimeoutError("search indexes not ready")
        time.sleep(10)


if __name__ == "__main__":
    regular_indexes()
    search_indexes()
    wait_ready()
    print("search indexes ready")
