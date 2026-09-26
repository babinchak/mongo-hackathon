import os
from pathlib import Path

from dotenv import load_dotenv
from pymongo import MongoClient

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

_client = None


def client() -> MongoClient:
    global _client
    if _client is None:
        _client = MongoClient(os.environ["MONGODB_URI"])
    return _client


def db():
    return client()[os.environ.get("MONGODB_DB", "hindsight")]


if __name__ == "__main__":
    c = client()
    c.admin.command("ping")
    info = c.admin.command("buildInfo")
    print("ping ok · server", info["version"])
