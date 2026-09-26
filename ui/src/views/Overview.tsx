import type { ReactNode } from "react";
import { getFunnel, getLeaderboard, getTimeline } from "../api";
import { FixtureNote } from "../components/ui";
import { href, isTuned, pct, REPOS, useAsync } from "../lib";
import type { Funnel, LeaderboardRow } from "../types";

type Phase = "ingest" | "mine" | "cases" | "eval";

interface Stage {
  label: string;
  sub: string;
  /** One line each (kept unbroken). */
  tag: string[];
  path: string;
  phase: Phase;
  value: (x: Counts) => number | undefined;
}

interface Counts {
  funnel?: Funnel;
  sessions?: number;
  configs?: number;
}

const STAGES: Stage[] = [
  { label: "SWE-chat", sub: "real agent sessions, 3 repos", tag: ["Hugging Face"], path: "/timeline", phase: "ingest", value: (x) => x.sessions },
  { label: "Atlas memory", sub: "prompts + replies, embedded", tag: ["text-embedding-", "3-large · 1024-d"], path: "/timeline", phase: "ingest", value: (x) => x.funnel?.events },
  { label: "Developer pushback", sub: "corrections, rejections", tag: ["SWE-chat labels"], path: "/moments", phase: "ingest", value: (x) => x.funnel?.pushback },
  { label: "Durable moments", sub: "still true weeks later", tag: ["gpt-6-luna mines", "gpt-6-sol audits"], path: "/moments", phase: "mine", value: (x) => x.funnel?.durable_moments },
  { label: "Eval cases", sub: "future task + fail signals", tag: ["gpt-6-astra"], path: "/cases", phase: "cases", value: (x) => x.funnel?.cases },
  { label: "Chat-only", sub: "repo doesn’t already answer", tag: ["git snapshot grep", "+ gpt-6-sol check"], path: "/cases", phase: "cases", value: (x) => x.funnel?.chat_only },
  { label: "Validated", sub: "pi fails without memory, passes with it", tag: ["pi × 2", "without / with"], path: "/review", phase: "cases", value: (x) => x.funnel?.validated },
  { label: "Harness sweep", sub: "memory configs ranked", tag: ["Atlas aggregation"], path: "/leaderboard", phase: "eval", value: (x) => x.configs },
];

const PHASES: { phase: Phase; label: string; span: number }[] = [
  { phase: "ingest", label: "Ingest", span: 3 },
  { phase: "mine", label: "Mine", span: 1 },
  { phase: "cases", label: "Generate + filter", span: 3 },
  { phase: "eval", label: "Evaluate", span: 1 },
];

const fmt = (n: number | undefined) => (n == null ? "—" : n.toLocaleString("en-US"));

export default function Overview() {
  const funnel = useAsync(() => getFunnel(), []);
  const lb = useAsync(() => getLeaderboard(undefined), []);
  const tl = useAsync(() => Promise.all(REPOS.map((r) => getTimeline(r).catch(() => undefined))), []);

  const sessions = tl.data?.every(Boolean) ? tl.data.reduce((a, t) => a + (t?.sessions.length ?? 0), 0) : undefined;
  const counts: Counts = { funnel: funnel.data, sessions, configs: lb.data?.length || undefined };

  return (
    <div className="ov">
      <header className="ov-hero">
        <h1>
          Hindsight <span className="ov-sub">long-horizon memory for coding agents</span>
        </h1>
        <p className="ov-pitch">
          Coding agents forget between sessions. Hindsight turns <strong>real agent history</strong> into a{" "}
          <strong>long-horizon memory benchmark</strong> — and uses it to <strong>evolve the agent’s memory harness</strong>.
        </p>
        <div className="ov-statements">
          <a className="ov-stmt" href={href("/leaderboard")}>
            <span className="ov-stmt-n">Statement 2</span>
            <span>
              <strong>Long-horizon engineering</strong> — memory across weeks of real sessions, measured by hard eval signals
            </span>
          </a>
          <a className="ov-stmt" href={href("/evolution")}>
            <span className="ov-stmt-n">Statement 1</span>
            <span>
              <strong>Recursive harnessing</strong> — the harness tunes its own memory config from eval failures
            </span>
          </a>
        </div>
      </header>

      <FixtureNote data={[funnel.data, lb.data]} />

      <section className="ov-pipe" aria-label="Pipeline">
        <div className="ov-pipe-head">
          <h2>Pipeline</h2>
          <span className="muted">live counts from Atlas · all {REPOS.length} repos · each stage opens its page</span>
        </div>
        <div className="ov-phases" aria-hidden>
          {PHASES.map((p) => (
            <div key={p.phase} className={`ov-phase ov-phase-${p.phase}`} style={{ gridColumn: `span ${p.span}` }}>
              {p.label}
            </div>
          ))}
        </div>
        <ol className="ov-stages">
          {STAGES.map((s) => (
            <li key={s.label} className={`ov-stage ov-stage-${s.phase}`}>
              <a href={href(s.path)}>
                <span className="ov-count">{fmt(s.value(counts))}</span>
                <span className="ov-label">{s.label}</span>
                <span className="ov-note">{s.sub}</span>
                <span className="ov-tag">
                  {s.tag.map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                </span>
              </a>
            </li>
          ))}
        </ol>
      </section>

      <Results rows={lb.data} error={lb.error} />

      <div className="ov-bottom">
        <AtlasPanel />
        <Architecture />
      </div>

      <footer className="ov-foot">
        Data: <strong>SWE-chat</strong> (SALT-NLP, ODC-By) · Agent: <strong>pi coding agent</strong> (MIT, used unmodified) · Everything else
        built at the event.
      </footer>
    </div>
  );
}

// ------------------------------------------------------------------ headline results
function Results({ rows, error }: { rows?: LeaderboardRow[]; error?: string }) {
  const full = (rows ?? []).filter((r) => !isTuned(r.config_id));
  const by = new Map(full.map((r) => [r.config_id, r]));
  const repo = by.get("repo_only");
  const mem = full.filter((r) => r.config_id !== "repo_only" && r.evidence_recall != null);
  const best = [...mem].sort((a, b) => b.pass_at_1 - a.pass_at_1 || b.pass_pow_3 - a.pass_pow_3)[0];
  const moments = by.get("hybrid_all");
  const turns = by.get("hybrid_turns");
  const runs = (rows ?? []).reduce((a, r) => a + (r.n_runs ?? 0), 0);
  const nCases = Math.max(0, ...full.map((r) => r.n_cases));
  const horizons = new Set(full.flatMap((r) => Object.keys(r.by_horizon ?? {}))).size;

  // Share of failed runs where memory had the gold evidence. Older backends lack the field: then
  // P(found ∧ fail) ≥ recall − pass@1 gives a lower bound.
  let unused: { v: number; bound: boolean } | undefined;
  if (best && best.pass_at_1 < 1) {
    if (best.retrieved_not_used != null) unused = { v: best.retrieved_not_used, bound: false };
    else if (best.evidence_recall != null && best.evidence_recall > best.pass_at_1)
      unused = { v: Math.min(1, (best.evidence_recall - best.pass_at_1) / (1 - best.pass_at_1)), bound: true };
  }

  const tiles: { key: string; tone: string; label: string; big: ReactNode; sub: ReactNode }[] = [];
  if (repo && best)
    tiles.push({
      key: "mem",
      tone: "pos",
      label: "Memory vs. repo-only · pass@1",
      big: (
        <>
          <span className="ov-kpi-from">{pct(repo.pass_at_1)}</span> → {pct(best.pass_at_1)}
        </>
      ),
      sub: <>best config: {best.label}</>,
    });
  if (moments && turns && turns.pass_at_1 > 0)
    tiles.push({
      key: "moments",
      tone: "accent",
      label: "Mined moments vs. raw turns",
      big: (
        <>
          {(moments.pass_at_1 / turns.pass_at_1).toFixed(1)}×<span className="ov-kpi-unit"> pass@1</span>
        </>
      ),
      sub: (
        <>
          {pct(moments.pass_at_1)} vs {pct(turns.pass_at_1)} · same hybrid retrieval
        </>
      ),
    });
  if (unused && best)
    tiles.push({
      key: "unused",
      tone: "warn",
      label: "Retrieved, but not used",
      big: (
        <>
          {unused.bound && unused.v < 0.995 ? "≥" : ""}
          {pct(unused.v)}
          <span className="ov-kpi-unit"> of failures</span>
        </>
      ),
      sub: <>memory returned the gold evidence; the agent didn’t act on it</>,
    });
  if (runs)
    tiles.push({
      key: "runs",
      tone: "neutral",
      label: "pi runs, judged",
      big: runs.toLocaleString("en-US"),
      sub: (
        <>
          {nCases} cases × {horizons || 1} horizon{horizons === 1 ? "" : "s"} × {rows!.length} configs
        </>
      ),
    });

  return (
    <a className="ov-results" href={href("/leaderboard")} aria-label="Headline results — open the leaderboard">
      {tiles.length ? (
        tiles.map((t) => (
          <div key={t.key} className={`ov-kpi ov-kpi-${t.tone}`}>
            <div className="ov-kpi-label">{t.label}</div>
            <div className="ov-kpi-big">{t.big}</div>
            <div className="ov-kpi-sub">{t.sub}</div>
          </div>
        ))
      ) : (
        <div className="ov-kpi ov-kpi-empty muted">{error ? `Leaderboard unavailable: ${error}` : rows ? "No sweep runs yet." : "Loading results…"}</div>
      )}
    </a>
  );
}

// ------------------------------------------------------------------ MongoDB Atlas
function AtlasPanel() {
  const items: [ReactNode, ReactNode][] = [
    [<code>memory</code>, <>one collection: raw turns + mined moments, 1024-d embeddings</>],
    [
      <>
        <code>$vectorSearch</code> + <code>$search</code>
      </>,
      <>Atlas Vector Search + Atlas Search BM25, fused with RRF</>,
    ],
    [<code>ts &lt; cutoff</code>, <>filtered inside Atlas on every query: the agent can’t see the future</>],
    [<code>superseded_at ≥ cutoff</code>, <>decisions already overturned at the cutoff are filtered out</>],
    [<code>aggregate()</code>, <>leaderboard and funnel computed live with aggregation pipelines</>],
    [
      <>
        <code>cases</code> <code>runs</code> <code>tuning</code>
      </>,
      <>
        the benchmark, every pi run, <code>harness_configs</code> and the self-tuning history
      </>,
    ],
  ];
  return (
    <section className="ov-panel">
      <h2>How MongoDB Atlas is used</h2>
      <dl className="ov-atlas">
        {items.map(([k, v], i) => (
          <div key={i} className="ov-atlas-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ------------------------------------------------------------------ architecture
function Architecture() {
  return (
    <section className="ov-panel">
      <h2>Architecture</h2>
      <div className="ov-arch">
        <div className="ov-node">
          <strong>SWE-chat</strong>
          <span>Hugging Face dataset</span>
        </div>
        <div className="ov-edge ov-edge-down">ingest · embed · mine</div>
        <div className="ov-node ov-node-atlas">
          <strong>MongoDB Atlas</strong>
          <span>memory · cases · runs · configs</span>
        </div>
        <div className="ov-edge ov-edge-up">$vectorSearch + $search, ts &lt; cutoff</div>
        <div className="ov-node">
          <strong>Memory service</strong>
          <span>FastAPI</span>
        </div>
        <div className="ov-edge ov-edge-up">search_memory tool + briefing</div>
        <div className="ov-node">
          <strong>pi + Hindsight extension</strong>
          <span>unmodified pi (MIT)</span>
        </div>
      </div>
    </section>
  );
}
