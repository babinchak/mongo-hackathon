import json
import os
from datetime import datetime, timezone

from openai import OpenAI

from hindsight.db import db

# $ per 1M tokens (input, output), from pi's model registry / OpenAI pricing
PRICES = {
    "gpt-6-luna": (0.10, 0.50), "gpt-6-sol": (2.0, 10.0), "gpt-6-astra": (10.0, 50.0),
    "gpt-5.4": (1.25, 10.0), "gpt-5.4-mini": (0.75, 4.5), "gpt-5.4-nano": (0.05, 0.40),
    "text-embedding-3-large": (0.13, 0.0), "text-embedding-3-small": (0.02, 0.0),
}

_client = None


def _log(model: str, stage: str, tokens_in: int, tokens_out: int) -> None:
    p_in, p_out = PRICES.get(model, (0.0, 0.0))
    try:
        db().llm_usage.insert_one({
            "model": model, "stage": stage, "tokens_in": tokens_in, "tokens_out": tokens_out,
            "cost_usd": (tokens_in * p_in + tokens_out * p_out) / 1e6, "ts": datetime.now(timezone.utc)})
    except Exception:
        pass  # accounting must never break the pipeline


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
        _log(model, "embed", r.usage.total_tokens, 0)
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
    _log(model, name, r.usage.input_tokens, r.usage.output_tokens)
    return json.loads(r.output_text)
