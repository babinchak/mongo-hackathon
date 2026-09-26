import { Fragment, type ReactNode } from "react";
import { getFunnel, getHeldout, getLeaderboard, getTimeline, getTuning, STATIC } from "../api";
import { DevChart, DevLegend, incumbents, knobChanges, latestTunedRun, TestBars, testOrder } from "../components/tuning";
import { FixtureNote } from "../components/ui";
import { configName, href, isTuned, pct, pts, REPOS, runsHref, useAsync } from "../lib";
import type { Funnel, HeldOut, LeaderboardRow, TuningRun } from "../types";

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

const fmt = (n: number | undefined) => (n == null ? "-" : n.toLocaleString("en-US"));

export default function Overview() {
  const funnel = useAsync(() => getFunnel(), []);
  const lb = useAsync(() => getLeaderboard(undefined), []);
  const tuning = useAsync(() => getTuning(), []);
  const held = useAsync(() => getHeldout(), []);
  const run = latestTunedRun(tuning.data);
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
          <strong>long-horizon memory benchmark</strong>, and uses it to <strong>evolve the agent’s memory harness</strong>.
        </p>
        <div className="ov-statements">
          <a className="ov-stmt" href={href("/leaderboard")}>
            <span className="ov-stmt-n">Statement 2</span>
            <span>
              <strong>Long-horizon engineering</strong>: memory across weeks of real sessions, measured by hard eval signals
            </span>
          </a>
          <a className="ov-stmt" href={href("/evolution")}>
            <span className="ov-stmt-n">Statement 1</span>
            <span>
              <strong>Recursive harnessing</strong>: the harness tunes its own memory config from eval failures
            </span>
          </a>
        </div>
      </header>

      <FixtureNote data={[funnel.data, lb.data, tuning.data]} />

      <section className="ov-pipe" aria-label="Pipeline">
        <div className="ov-pipe-head">
          <h2>Pipeline</h2>
          <span className="muted">{STATIC ? "counts exported from Atlas" : "live counts from Atlas"} · all {REPOS.length} repos · each stage opens its page</span>
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

      <Results rows={lb.data} error={lb.error} run={run} held={held.data} />

      <div className="ov-mid">
        <TuningPanel run={run} error={tuning.error ?? (tuning.data && !run ? "no tuning runs yet" : undefined)} />
        <LeaderMini rows={lb.data} error={lb.error} />
      </div>

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
/** Best hand-designed memory config on the full suite (tuned configs excluded: they only see part of it fairly). */
function bestHandDesigned(rows: LeaderboardRow[]): LeaderboardRow | undefined {
  const mem = rows.filter((r) => !isTuned(r.config_id) && r.config_id !== "repo_only" && r.evidence_recall != null);
  return [...mem].sort((a, b) => b.pass_at_1 - a.pass_at_1 || b.pass_pow_3 - a.pass_pow_3)[0];
}

function Results({ rows, error, run, held }: { rows?: LeaderboardRow[]; error?: string; run?: TuningRun; held?: HeldOut }) {
  const full = (rows ?? []).filter((r) => !isTuned(r.config_id));
  const by = new Map(full.map((r) => [r.config_id, r]));
  const repo = by.get("repo_only");
  const best = bestHandDesigned(rows ?? []);
  const moments = by.get("hybrid_all");
  const turns = by.get("hybrid_turns");
  const runs = (rows ?? []).reduce((a, r) => a + (r.n_runs ?? 0), 0);
  const nCases = Math.max(0, ...full.map((r) => r.n_cases));
  const horizons = new Set(full.flatMap((r) => Object.keys(r.by_horizon ?? {}))).size;

  // Share of failed runs where memory had the gold evidence. Older backends lack the field: then
  // P(found and fail) >= recall - pass@1 gives a lower bound.
  let unused: { v: number; bound: boolean } | undefined;
  if (best && best.pass_at_1 < 1) {
    if (best.retrieved_not_used != null) unused = { v: best.retrieved_not_used, bound: false };
    else if (best.evidence_recall != null && best.evidence_recall > best.pass_at_1)
      unused = { v: Math.min(1, (best.evidence_recall - best.pass_at_1) / (1 - best.pass_at_1)), bound: true };
  }

  const side: { key: string; tone: string; href: string; big: ReactNode; label: ReactNode; sub: ReactNode }[] = [];
  if (unused && best)
    side.push({
      key: "unused",
      tone: "warn",
      href: runsHref(best.config_id, { unused: "1" }),
      big: `${unused.bound && unused.v < 0.995 ? "≥" : ""}${pct(unused.v)}`,
      label: "of failures had the answer retrieved",
      sub: <>memory returned the gold evidence; pi didn’t act on it</>,
    });
  if (moments && turns && turns.pass_at_1 > 0)
    side.push({
      key: "moments",
      tone: "accent",
      href: href("/moments"),
      big: `${(moments.pass_at_1 / turns.pass_at_1).toFixed(1)}×`,
      label: "pass@1: mined moments vs. raw turns",
      sub: (
        <>
          {pct(moments.pass_at_1)} vs {pct(turns.pass_at_1)} with the same hybrid retrieval
        </>
      ),
    });
  if (runs)
    side.push({
      key: "runs",
      tone: "neutral",
      href: href("/leaderboard"),
      big: runs.toLocaleString("en-US"),
      label: "pi runs, judged",
      sub: (
        <>
          {nCases} cases × {horizons || 1} horizon{horizons === 1 ? "" : "s"} × {rows!.length} configs
        </>
      ),
    });

  const hero = <Progression held={held} run={run} best={best} repo={repo} />;
  if (!side.length && !hero)
    return (
      <div className="ov-results">
        <div className="ov-kpi ov-kpi-empty muted">{error ? `Leaderboard unavailable: ${error}` : rows ? "No sweep runs yet." : "Loading results…"}</div>
      </div>
    );

  return (
    <div className="ov-results">
      {hero}
      <div className="ov-side">
        {side.map((t) => (
          <a key={t.key} className={`ov-kpi ov-kpi-${t.tone}`} href={t.href}>
            <div className="ov-kpi-big">{t.big}</div>
            <div className="ov-kpi-text">
              <div className="ov-kpi-label">{t.label}</div>
              <div className="ov-kpi-sub">{t.sub}</div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

interface ProgStep {
  kind: "repo" | "hand" | "tuned";
  n: string;
  name: string;
  sub: ReactNode;
  title?: string;
}

/** The hero card: repo only, then the best hand-designed memory, then the self-tuned harness. */
function ProgCard({ to, title, note, steps, foot }: { to: string; title: string; note: ReactNode; steps: ProgStep[]; foot?: ReactNode }) {
  return (
    <a className="ov-prog" href={href(to)} aria-label={`Headline result: open ${to.slice(1)}`}>
      <div className="ov-prog-head">
        <span className="ov-prog-title">{title}</span>
        <span className="ov-prog-note">{note}</span>
      </div>
      <div className="ov-prog-steps">
        {steps.map((st, i) => (
          <Fragment key={st.kind}>
            {i > 0 && (
              <div className="ov-prog-arrow" aria-hidden>
                →
              </div>
            )}
            <div className={`ov-prog-step ov-prog-${st.kind}`} title={st.title}>
              <div className="ov-prog-n">{st.n}</div>
              <div className="ov-prog-name">
                {st.kind === "tuned" && (
                  <span className="ov-prog-star" aria-hidden>
                    ✦{" "}
                  </span>
                )}
                {st.name}
              </div>
              <div className="ov-prog-sub">{st.sub}</div>
            </div>
          </Fragment>
        ))}
      </div>
      {foot && <div className="ov-prog-foot">{foot}</div>}
    </a>
  );
}

/**
 * Hero numbers, best source first: GET /api/heldout (later cutoffs the tuner never saw, every horizon,
 * k repeats), else the latest tuning run's own test split, else the full-suite leaderboard.
 */
function Progression({ held, run, best, repo }: { held?: HeldOut; run?: TuningRun; best?: LeaderboardRow; repo?: LeaderboardRow }) {
  const accepted = (run?.steps ?? []).slice(1).filter((s) => s.accepted).length;
  const acceptedNote = run?.steps?.length ? ` · ${accepted} accepted step${accepted === 1 ? "" : "s"}` : "";

  const hc = held?.configs ?? [];
  const hRepo = hc.find((c) => c.config_id === "repo_only");
  const hStart = held && hc.find((c) => c.config_id === held.start);
  const hBest = held && held.best !== held.start ? hc.find((c) => c.config_id === held.best) : undefined;
  if (held && hRepo && hStart && hBest) {
    const ns = [...new Set([hRepo, hStart, hBest].map((c) => c.n_runs))];
    const k = hBest.k;
    const horizons = Math.max(1, ...[hRepo, hStart, hBest].map((c) => Math.ceil(c.n_units / Math.max(1, c.n_cases))));
    return (
      <ProgCard
        to="/evolution"
        title="Pass@1 on held-out cases"
        note={
          <>
            held-out cases (later cutoffs, never tuned on) · {held.n_test_cases} cases × {horizons > 1 ? `up to ${horizons} horizons` : "1 horizon"} × {k}{" "}
            repeats = {ns.length === 1 ? `${ns[0]} runs per config` : `${ns.join(" / ")} runs`}
          </>
        }
        steps={[
          { kind: "repo", n: pct(hRepo.pass_at_1), name: "Repo only", sub: "no memory" },
          { kind: "hand", n: pct(hStart.pass_at_1), name: "Best hand-designed memory", sub: hStart.label, title: hStart.config_id },
          {
            kind: "tuned",
            n: pct(hBest.pass_at_1),
            name: "Self-tuned harness",
            sub: <>{pts(hBest.pass_at_1 - hStart.pass_at_1)} pts over its start config{acceptedNote}</>,
            title: configName(hBest.config_id),
          },
        ]}
        foot={
          <>
            <span className="ov-prog-foot-k">
              Reliability · pass^{k} <span className="muted">(passes all {k} tries)</span>
            </span>{" "}
            <span className="ov-prog-foot-v">
              <span className="muted">{pct(hRepo.pass_pow_k)}</span> → {pct(hStart.pass_pow_k)} → <strong>{pct(hBest.pass_pow_k)}</strong>
            </span>
          </>
        }
      />
    );
  }

  const t = run?.test;
  const tRepo = t?.repo_only;
  const tStart = run && t?.[run.start];
  const tBest = run && run.best !== run.start ? t?.[run.best] : undefined;
  if (run && tRepo && tStart && tBest) {
    const ns = [...new Set([tRepo, tStart, tBest].map((x) => x.n_runs))];
    const handLo = Math.round(tStart.pass_at_1 * 100);
    const handHi = best ? Math.round(best.pass_at_1 * 100) : handLo;
    return (
      <ProgCard
        to="/evolution"
        title="Pass@1 on held-out cases"
        note={<>held-out test (later cutoffs, never tuned on), n={ns.length === 1 ? `${ns[0]} runs each` : ns.join(" / ")}</>}
        steps={[
          { kind: "repo", n: pct(tRepo.pass_at_1), name: "Repo only", sub: "no memory" },
          {
            kind: "hand",
            n: handHi > handLo ? `${handLo}–${handHi}%` : `${handLo}%`,
            name: "Best hand-designed memory",
            sub: (
              <>
                {pct(tStart.pass_at_1)} held-out{handHi > handLo && best && <> · {pct(best.pass_at_1)} best full-suite</>}
              </>
            ),
            title: configName(run.start),
          },
          {
            kind: "tuned",
            n: pct(tBest.pass_at_1),
            name: "Self-tuned harness",
            sub: <>{pts(tBest.pass_at_1 - tStart.pass_at_1)} pts over its start config{acceptedNote}</>,
            title: configName(run.best),
          },
        ]}
      />
    );
  }

  if (repo && best)
    return (
      <ProgCard
        to="/leaderboard"
        title="Pass@1, memory vs. repo only"
        note="full suite · self-tuning results appear once a tuning run finishes"
        steps={[
          { kind: "repo", n: pct(repo.pass_at_1), name: "Repo only", sub: "no memory" },
          { kind: "hand", n: pct(best.pass_at_1), name: "Best memory config", sub: best.label },
        ]}
      />
    );
  return null;
}

// ------------------------------------------------------------------ the harness tuned itself
function TuningPanel({ run, error }: { run?: TuningRun; error?: string }) {
  const steps = run?.steps ?? [];
  const incs = incumbents(steps);
  const changes = steps
    .map((s, i) => ({ s, i, inc: incs[i] }))
    .filter(({ s, i }) => i > 0 && s.accepted)
    .map(({ s, i, inc }) => ({ s, i, inc, knobs: knobChanges(s, inc).filter((k) => k.changed) }));
  const rejected = steps.slice(1).filter((s) => !s.accepted).length;

  return (
    <section className="ov-panel ov-tune">
      <header className="ov-panel-head">
        <h2>The harness tuned itself</h2>
        <a className="ov-more" href={href("/evolution")}>
          Evolution →
        </a>
      </header>
      {!run ? (
        <div className="empty">{error ? `Tuning runs unavailable: ${error}` : "Loading the tuning run…"}</div>
      ) : (
        <>
          <p className="ov-tune-lede">
            An LLM reads the incumbent config’s eval failures, proposes one knob change, and the harness keeps it only if it beats the incumbent on{" "}
            <strong>dev</strong> ({run.dev_cases?.length ?? 0} earlier-cutoff cases).
          </p>
          <div className="ov-tune-grid">
            <div className="ov-tune-chart">
              <div className="ov-sublabel">Dev pass@1 per step</div>
              <DevChart steps={steps} running={run.status === "running"} w={360} h={240} />
              <DevLegend />
            </div>
            <div className="ov-tune-right">
              <div className="ov-sublabel">
                Accepted changes{rejected > 0 && <span className="muted"> · {rejected} rejected</span>}
              </div>
              <ol className="ov-changes">
                {changes.map(({ s, i, inc, knobs }) => (
                  <li key={s.config_id}>
                    <span className="ov-change-step">#{i}</span>
                    <span className="ov-change-knobs">
                      {knobs.length ? (
                        knobs.map((k, j) => (
                          <span key={k.key}>
                            {j > 0 && ", "}
                            <span className="ov-change-k">{k.label}</span> {k.was} → <strong>{k.now}</strong>
                          </span>
                        ))
                      ) : (
                        <span className="muted">no knob change</span>
                      )}
                    </span>
                    {inc && <span className="ov-change-d">{pts(s.dev_pass_at_1 - inc.dev_pass_at_1)}</span>}
                  </li>
                ))}
                {!changes.length && <li className="muted">No accepted changes yet.</li>}
              </ol>
              {run.test && testOrder(run).length > 0 && (
                <>
                  <div className="ov-sublabel ov-sublabel-gap">
                    Held-out <span className="muted">· tuner’s own check at +7 days (n={testN(run)})</span>
                  </div>
                  <TestBars run={run} roleFirst />
                </>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/** Runs per config in the tuner's own held-out check ("72", or "72 / 70" when they differ). */
const testN = (run: TuningRun) => [...new Set(testOrder(run).map((c) => run.test![c].n_runs))].join(" / ");

// ------------------------------------------------------------------ leaderboard mini chart
function LeaderMini({ rows, error }: { rows?: LeaderboardRow[]; error?: string }) {
  const sorted = [...(rows ?? [])].sort((a, b) => b.pass_at_1 - a.pass_at_1 || a.label.localeCompare(b.label));
  const tuned = sorted.find((r) => isTuned(r.config_id));
  const nCases = Math.max(0, ...sorted.map((r) => r.n_cases));
  const scale = Math.max(0.5, Math.ceil(Math.max(0, ...sorted.map((r) => r.pass_at_1)) * 10) / 10);
  return (
    <section className="ov-panel ov-lbmini">
      <header className="ov-panel-head">
        <h2>Leaderboard · pass@1</h2>
        <a className="ov-more" href={href("/leaderboard")}>
          Leaderboard →
        </a>
      </header>
      {!sorted.length ? (
        <div className="empty">{error ? `Leaderboard unavailable: ${error}` : rows ? "No sweep runs yet." : "Loading…"}</div>
      ) : (
        <>
          <p className="ov-tune-lede">
            Same agent and tasks; only the memory changes · all {nCases} cases
          </p>
          <ol className="lbm">
            {sorted.map((r) => {
              const isT = isTuned(r.config_id);
              const kind = isT ? "tuned" : r.config_id === "repo_only" ? "none" : "hand";
              return (
                <li key={r.config_id} className={`lbm-row lbm-${kind}`}>
                  <a href={runsHref(r.config_id)} title={`${r.label} · pass@1 ${pct(r.pass_at_1)} · n=${r.n_runs} runs`}>
                    <span className="lbm-label">
                      {isT && <span className="badge-tuned">✦ tuned</span>}
                      <span className="lbm-name">{r.label}</span>
                    </span>
                    <span className="lbm-track">
                      <span className="lbm-bar" style={{ ["--w" as string]: Math.min(1, r.pass_at_1 / scale) }} />
                      <span className="lbm-val">
                        {pct(r.pass_at_1)}
                        {isT && <sup>✦</sup>}
                      </span>
                    </span>
                  </a>
                </li>
              );
            })}
          </ol>
          {tuned && (
            <p className="lbm-foot">
              <sup>✦</sup> The self-tuned config’s full-suite number includes the dev cases it was tuned on; the fair comparison is the held-out test
              above.
            </p>
          )}
        </>
      )}
    </section>
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
