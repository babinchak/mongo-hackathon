import os

from dotenv import load_dotenv
from pymongo import MongoClient

load_dotenv()

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
