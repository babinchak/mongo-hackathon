# Contracts (frozen; change only via the integrator)

Shared shapes for the pipeline, memory service, pi harness, and UI. All timestamps are UTC
`datetime` in Mongo and ISO-8601 strings (`2026-03-01T12:00:00Z`) over HTTP.

Database: `hindsight` (env `MONGODB_DB`). Python access: `from hindsight.db import db`.
LLM access: `from hindsight.llm import embed, chat_json`. Models come from `.env`
(`MINE_MODEL`, `LINK_MODEL`, `CASE_MODEL`, `JUDGE_MODEL`, `PI_MODEL`).

## Directory ownership

| Path | Owner |
|---|---|
| `hindsight/db.py`, `hindsight/llm.py`, `hindsight/memory/`, `hindsight/pipeline/`, `hindsight/api.py`, `CONTRACTS.md` | integrator |
| `hindsight/ingest/`, `hindsight/indexes.py` | ingest |
| `hindsight/snapshots/` (+ `repos/`, `snapshots/` on disk, gitignored) | snapshots |
| `agent/` (pi install + extension), `hindsight/runner/` | pi harness |
| `ui/` | UI |

## Collections

### `sessions`
```json
{ "_id": "<session_id>", "repo_id": "FSM1/cipher-box", "started_at": "<datetime>",
  "agent": "Claude Code", "prompts": 42, "branch": "main" }
```

### `memory`: turns AND moments in one collection (one vector + one text index)
Common fields:
```json
{ "_id": "<turn_id> | m:<turn_id>", "kind": "turn | moment", "repo_id": "...",
  "session_id": "...", "seq": 17, "ts": "<datetime>", "text": "what gets embedded + BM25",
  "embedding": [512 floats]            // absent when noise
}
```
Turn-only: `role` (`user|assistant`), `pushback` (`correction|failure_report|rejection|takeover|null`),
`noise` (bool; noise turns are stored but never embedded or returned).

Moment-only: `moment_kind` (`constraint|decision|fact|procedure|failed_approach|none`), `topic`,
`confidence` (1–5), `durable` (bool), `source_turn_id`, `evidence` ([turn_ids]),
`repeats`, `repeated_by`, `supersedes`, `superseded_by` ([moment ids]),
`superseded_at` (datetime of the earliest superseding moment; `9999-12-31` if never).

Every memory doc also carries `durable` (false on turns) and `superseded_at` (`9999-12-31` on
turns) so both indexes can filter uniformly.

Search indexes on `memory` (created by `hindsight/indexes.py`):
- `memory_vec` (vectorSearch): `embedding` 512 cosine; filter fields `repo_id`, `ts`, `kind`,
  `durable`, `superseded_at`, `noise`.
- `memory_text` (search): `text` (lucene.english); `repo_id`, `kind` as token; `ts`,
  `superseded_at` as date; `durable`, `noise` as boolean.

**Invariant: every query against `memory` filters `repo_id` and `ts < cutoff` inside Atlas,
vector AND text. `drop_superseded` means `superseded_at >= cutoff` (superseded as of the cutoff,
not as of today).**

Regular indexes: `memory(repo_id, ts)`, `memory(session_id, seq)`, `cases(repo_id, status)`,
`runs(case_id, config_id)`.

### `cases`
```json
{ "_id": "c:<moment_id>", "repo_id": "...", "moment_id": "m:...",
  "scenario": "durable_constraint | superseded_decision | failed_approach",
  "task": "realistic future task, no hint", "expected": "correct behavior",
  "fail_signals": ["git tag", "..."], "keywords": ["..."], "gold_evidence": ["<turn_id>", "m:..."],
  "cutoffs": [{"horizon_days": 7, "cutoff": "<datetime>", "session_id": "...", "commit": "<sha>"}],
  "repeated_in_real_life": false, "chat_only": true | false | null,
  "status": "generated | filtered_out | validated | rejected | approved",
  "validation": {"repo_only": ["fail","fail"], "oracle": ["pass","pass"]},
  "review": {"verdict": "approve|reject", "reason": "..."} }
```

### `harness_configs`
```json
{ "_id": "hybrid_all_brief", "label": "Hybrid · moments+turns · briefing",
  "memory": true, "retrieval": "vector | bm25 | hybrid", "source": "turns | moments | moments+turns",
  "k": 8, "briefing": true, "drop_superseded": true, "recency_weight": 0.0 }
```
`repo_only` has `"memory": false`. `oracle` pastes `gold_evidence` into the prompt (validation only).

### `runs`
```json
{ "_id": "<uuid>", "case_id": "...", "config_id": "...", "repeat": 0, "horizon_days": 7,
  "cutoff": "<datetime>", "commit": "<sha>", "model": "gpt-5.4-mini",
  "tool_calls": [{"tool": "read", "args": {...}}], "used_memory_tool": true,
  "context_ids": ["m:...", "<turn_id>"], "hit_gold": true, "response": "final plan text",
  "verdict": "pass | fail | error", "reason": "judge reason", "cost_usd": 0.04,
  "turns": 10, "duration_s": 28.1, "created_at": "<datetime>" }
```

## Memory service HTTP API (FastAPI, `hindsight/api.py`, default `http://127.0.0.1:8000`)

`POST /api/memory/search`
```json
// request
{ "repo_id": "FSM1/cipher-box", "cutoff": "2026-02-01T00:00:00Z", "query": "release process",
  "config_id": "hybrid_all_brief", "k": 8 }
// response
{ "items": [ { "id": "m:abc", "kind": "moment", "ts": "...", "session_id": "...",
               "text": "...", "score": 0.83, "moment_kind": "constraint", "topic": "release",
               "source_turn_id": "abc" } ] }
```
Moments first, then turns. `k` optional (defaults to config's `k`).

`POST /api/memory/briefing`: same request (no `k`); response `{ "text": "markdown bullets", "ids": [...] }`.
Current (not superseded as of cutoff) durable decisions/constraints relevant to the query.

## pi extension env
`HINDSIGHT_API` (base URL), `HINDSIGHT_REPO`, `HINDSIGHT_CUTOFF` (ISO), `HINDSIGHT_CONFIG`.
Unset `HINDSIGHT_REPO` → extension is a no-op (plain pi).
