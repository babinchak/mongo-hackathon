# Hindsight

**A temporal memory benchmark mined from real coding-agent history, and a MongoDB Atlas memory
layer for the pi coding agent that it tunes.**

Coding agents forget everything between sessions, so developers correct the same things over and
over. Hindsight takes a project's real human–agent history, pulls out the knowledge the developer
had to *tell* the agent (constraints, decisions, procedures, approaches that failed), and turns it
into eval cases that are pinned to a point in time. It then drops the pi coding agent into the
repo as it was at that date and measures which memory design helps. Every memory lookup is
bounded by the cutoff **inside Atlas**, so the agent can never see the future.

MongoDB Hackathon NYC · Sept 26, 2026 · Problem statement 2: Long Horizon Engineering.

## What was built at this event vs. what is external

Everything in this repository was written during the event (see the commit history, which starts
at 10:40 on Sept 26).

| Built at the event | External (used, not modified) |
|---|---|
| Ingest of SWE-chat into Atlas with noise filtering and embeddings | [SWE-chat](https://huggingface.co/datasets/SALT-NLP/SWE-chat) dataset (SALT-NLP, **ODC-By**): input data, not redistributed |
| Mining, auditing and linking of "moments" (repeats and supersessions) | [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (`@earendil-works/pi-coding-agent` 0.87.1, **MIT**): an npm dependency, unmodified |
| Case generation, the chat-only filter and validation with pi | OpenAI models (gpt-6 family, text-embedding-3-large) |
| Cutoff-bounded memory service (vector, BM25, hybrid) on Atlas | MongoDB Atlas (event sandbox) |
| pi memory extension (`agent/extensions/hindsight-memory.ts`) | |
| Point-in-time repo snapshots, eval runner, judge, sweep and leaderboard | |
| React UI: leaderboard, case inspector with Run now, moments browser, review queue, timeline | |

## How it works

```text
SWE-chat (real Claude Code sessions)          GitHub repo (blobless clone)
        │                                              │
  ingest ──► Atlas `memory` (turns + embeddings)       │  snapshot at cutoff: git archive, no .git
        │                                              │
  mine   ──► moments: "never push tags by hand; merge the release-please PR"
  audit  ──► keep only knowledge that generalizes
  link   ──► said-again (repeats) · decision-changed (supersedes, dated)
        │
  cases  ──► realistic future task + expected behavior + fail signals + cutoffs (+1/+7/+21 days)
  chat-only filter ◄── grep the snapshot: does the repo already document it? → drop
  validate: pi on the repo alone must FAIL; pi with the gold evidence must PASS
        │
  sweep: pi + memory extension × harness configs × horizons × repeats ──► judge ──► leaderboard
```

**Memory service** (`hindsight/memory/`): one `memory` collection holds raw turns and mined
moments, with one Atlas Vector Search index and one Atlas Search (BM25) index. Every query filters
`repo_id` and `ts < cutoff` inside Atlas, for vector and keyword search alike. The option to drop
superseded decisions is evaluated **as of the cutoff** (`superseded_at >= cutoff`), not as of
today. Hybrid search uses reciprocal rank fusion (the sandbox runs MongoDB 8.0, so `$rankFusion`
isn't available).

**pi extension** (`agent/extensions/hindsight-memory.ts`): registers a `search_memory` tool and,
when the config enables it, adds a briefing of current decisions and constraints to the system
prompt. If `HINDSIGHT_REPO` is unset it does nothing, which makes it plain pi.

**Harness configs** (`harness_configs` collection): `repo_only`, `vector_turns`, `hybrid_turns`,
`hybrid_all` (moments + turns), `hybrid_all_brief` (+ briefing), and `ablate_superseded` (briefing
with superseded decisions left in).

**Metrics:** pass@1 (mean over repeats), pass^3 (passed in *every* repeat; pi isn't
deterministic), evidence recall (did memory return the gold moment), memory-tool use, and cost.
All are computed with MongoDB aggregation pipelines (`hindsight/memory/stats.py`).

## Honesty notes

- Snapshots contain no `.git`, so the agent can't run `git log` to see the future. They do keep
  the team's own docs (`.claude/`, `.planning/`, `AGENTS.md`), which is the realistic baseline
  memory has to beat.
- Cases the repo already answers are dropped by the chat-only filter before any pi run.
- Moment-based memory shares its extraction step with case generation (a home advantage). Cases
  where the developer really did repeat themselves are reported separately.
- The judge sees the task, expected behavior, fail signals and the plan, never the evidence.
- The results are a pilot; the leaderboard shows n in every cell.

## Running it

```bash
cp .env.example .env            # MONGODB_URI, OPENAI_API_KEY, SWE_CHAT_DIR, model names
uv sync && (cd agent && npm install) && (cd ui && npm install)

uv run python -m hindsight.ingest --repo FSM1/cipher-box
uv run python -m hindsight.indexes
uv run python -m hindsight.memory.configs
for s in mine refine link; do uv run python -m hindsight.pipeline.$s --repo FSM1/cipher-box; done
uv run python -m hindsight.pipeline.cases --repo FSM1/cipher-box
uv run python -m hindsight.pipeline.chat_only --repo FSM1/cipher-box
uv run uvicorn hindsight.api:app --port 8000 &   # memory service + UI API
uv run python -m hindsight.pipeline.validate --repo FSM1/cipher-box
uv run python -m hindsight.pipeline.sweep
(cd ui && npm run dev)                            # http://localhost:5173
```

## Layout

```text
hindsight/ingest/      SWE-chat → Atlas
hindsight/pipeline/    mine · refine · link · cases · chat_only · validate · sweep · evaluate (judge)
hindsight/memory/      cutoff-bounded search + briefing, harness configs, leaderboard/funnel aggregations
hindsight/snapshots/   point-in-time repo exports + grep
hindsight/runner/      headless pi runner (JSON event stream → run record)
hindsight/api.py       FastAPI: memory service + UI API
agent/                 pi dependency + the Hindsight memory extension
ui/                    React + Vite UI
```
