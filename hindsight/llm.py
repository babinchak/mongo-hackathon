import json
import os

from openai import OpenAI

import hindsight.db  # noqa: F401  (loads .env)

_client = None


def client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI()
    return _client


def embed(texts: list[str], batch: int = 256) -> list[list[float]]:
    """Embed texts (each truncated to 4k chars) at EMBED_DIMS dimensions."""
    model = os.environ.get("EMBED_MODEL", "text-embedding-3-small")
    dims = int(os.environ.get("EMBED_DIMS", "512"))
    out: list[list[float]] = []
    for i in range(0, len(texts), batch):
        chunk = [(t or " ")[:4000] for t in texts[i : i + batch]]
        r = client().embeddings.create(model=model, input=chunk, dimensions=dims)
        out.extend(d.embedding for d in r.data)
    return out


def chat_json(model: str, system: str, user: str, schema: dict | None = None, name: str = "out") -> dict:
    """One LLM call returning parsed JSON. Pass a JSON schema for strict structured output."""
    fmt = (
        {"type": "json_schema", "name": name, "schema": schema, "strict": True}
        if schema
        else {"type": "json_object"}
    )
    r = client().responses.create(
        model=model,
        instructions=system,
        input=user if schema else user + "\n\nRespond in JSON.",
        text={"format": fmt},
    )
    return json.loads(r.output_text)
