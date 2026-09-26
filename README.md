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

## Results (pilot)

Data: 3 real repos from SWE-chat (FSM1/cipher-box, marcus-sa/brain, melagiri/code-insights).
They contain 566 sessions and 16,560 turns. From 2,654 pushback turns we mined **680 durable
moments** and wrote 207 cases. **120** survived the chat-only filter and **47** passed validation
(pi fails with the repo alone, passes with the evidence). We then ran 2,835 pi runs
(gpt-6-luna) across every config × case × horizon (+1/+7/+21 days) × 3 repeats.

| Harness config | pass@1 | pass^3 | evidence recall | pass@1 at +1d → +7d → +21d |
|---|---|---|---|---|
| Repo only (no memory) | 0.04 | 0.00 | n/a | 0.04 → 0.03 → 0.05 |
| Vector · raw turns | 0.15 | 0.06 | 0.40 | 0.18 → 0.14 → 0.13 |
| Hybrid · raw turns | 0.15 | 0.04 | 0.45 | 0.20 → 0.14 → 0.11 |
| Hybrid · moments + turns | 0.38 | 0.18 | 0.92 | 0.40 → 0.34 → 0.40 |
| Hybrid · moments + turns · briefing | 0.41 | 0.21 | 0.93 | 0.47 → 0.43 → 0.33 |
| Hybrid + briefing, keep superseded | 0.44 | 0.21 | 0.93 | 0.51 → 0.40 → 0.40 |
| **Self-tuned (round 4)**¹ | **0.72** | **0.57** | 0.89 | 0.74 → 0.72 → 0.71 |

Findings:
1. **Memory matters.** Pass@1 goes from 4% with the repo alone to 44% with Atlas memory.
2. **Mined moments beat raw chat by about 2.7×**, mostly because retrieval recall jumps from about
   0.4 to 0.93.
3. **Retrieval isn't the bottleneck; use is.** About 88% of failures with moment-based memory
   *had* the gold evidence in context.
4. **Long-horizon decay.** Hand-designed configs lose accuracy as the gap between being told
   something and needing it grows (e.g. 0.47 → 0.33 from +1 to +21 days).
5. **The harness can fix this itself.** The self-tuning loop (`hindsight/pipeline/tune.py`) read
   failures and changed *presentation*, not retrieval. It frames memory as binding rules, restates
   the applicable rules before planning, uses moments only, briefs fewer items, and weights recent
   ones slightly. On the **held-out test split** (later cutoffs, never used for tuning) it scores
   **0.67 vs 0.40** for the best hand-designed config (0.04 repo-only, n=72 runs each).
6. **Judge check.** gpt-6-astra re-graded a random 60 runs and agreed with the gpt-6-sol judge on
   54 (90%). All 6 disagreements were sol failing plans astra would pass, so the judge errs strict.

¹ The full-suite number includes the 23 dev cases the tuner optimized on. The held-out figure
(0.67) is the honest one. The "keep superseded" vs "drop superseded" difference is within noise:
only 3 of the 47 cases are superseded decisions.

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

## Demo walkthrough (UI at http://localhost:5173)

1. **Overview** (`#/`): the pipeline with live counts from Atlas, headline results, and how Atlas is used.
2. **Moments** (`#/moments`): mined project knowledge next to the developer's original words, with
   repeat and supersede links. Try the cipher-box moment about the staging VPS SSH key.
3. **Case inspector** (`#/cases/...`): the task, expected behavior, every run grouped by config,
   and **Run now**, which runs pi live against the snapshot (~20 s).
4. **Leaderboard** (`#/leaderboard`): configs on the full suite, found-vs-used gap, horizon decay.
5. **Evolution** (`#/evolution`): the self-tuning trajectory and its held-out test result.

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
uv run python -m hindsight.pipeline.sweep --workers 24
uv run python -m hindsight.pipeline.tune --rounds 5 --start hybrid_all_brief
uv run python -m hindsight.pipeline.judge_audit -n 60
(cd ui && npm run dev)                            # http://localhost:5173
```

## Layout

```text
hindsight/ingest/      SWE-chat → Atlas
hindsight/pipeline/    mine · refine · link · cases · chat_only · validate · sweep · evaluate (judge) · tune · judge_audit
hindsight/memory/      cutoff-bounded search + briefing, harness configs, leaderboard/funnel aggregations
hindsight/snapshots/   point-in-time repo exports + grep
hindsight/runner/      headless pi runner (JSON event stream → run record)
hindsight/api.py       FastAPI: memory service + UI API
agent/                 pi dependency + the Hindsight memory extension
ui/                    React + Vite UI
```
