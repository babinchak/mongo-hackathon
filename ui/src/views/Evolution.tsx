import { useEffect, useState } from "react";
import { getConfigs, getTuning, STATIC } from "../api";
import { ErrorBox, FixtureNote, Loading, Panel } from "../components/ui";
import { configName, fmtDate, fmtTime, pct, pts, useAsync } from "../lib";
import type { HarnessConfig, TuningKnobs, TuningRun, TuningStep } from "../types";

const POLL_MS = 15_000;

const KNOBS: { key: keyof TuningKnobs; label: string }[] = [
  { key: "retrieval", label: "retrieval" },
  { key: "source", label: "source" },
  { key: "k", label: "k" },
  { key: "briefing", label: "briefing" },
  { key: "briefing_k", label: "briefing k" },
  { key: "drop_superseded", label: "drop superseded" },
  { key: "recency_weight", label: "recency" },
  { key: "framing", label: "framing" },
  { key: "nudge", label: "nudge" },
];

/** Harness defaults for knobs older configs don't set (hindsight/memory/search.py, runner/pi_runner.py). */
const DEFAULTS: Partial<Record<keyof TuningKnobs, unknown>> = {
  k: 8,
  briefing: false,
  briefing_k: 8,
  drop_superseded: true,
  recency_weight: 0,
  framing: "notes",
  nudge: "search_first",
};
const knobValue = (c: TuningKnobs | undefined, k: keyof TuningKnobs) => c?.[k] ?? DEFAULTS[k];
const fmtKnob = (v: unknown) =>
  v == null ? "default" : typeof v === "boolean" ? (v ? "on" : "off") : String(v).replace("_", " ");

export default function Evolution() {
  const runs = useAsync(() => getTuning(), []);
  const cfgs = useAsync(() => getConfigs(), []);
  const [pick, setPick] = useState<string>();

  const list = runs.data ?? [];
  const run = list.find((r) => r._id === pick) ?? list[0];
  const running = run?.status === "running";
  const { reload } = runs;
  useEffect(() => {
    if (!running || STATIC) return;
    const t = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(t);
  }, [running, reload]);

  if (runs.error && !runs.data) return <ErrorBox error={runs.error} retry={runs.reload} />;
  if (!runs.data) return <Loading what="tuning runs" />;

  const cfgById = new Map((cfgs.data ?? []).map((c) => [c._id, c]));

  return (
    <div className="stack">
      <div className="page-head evo-head">
        <div>
          <h1>
            Evolution: the harness tunes its own memory
            {run && <StatusPill status={run.status} />}
          </h1>
          <p className="lede">
            Recursive harnessing: an LLM reads the incumbent config’s eval failures (was the gold evidence retrieved, or retrieved and ignored?), proposes
            one new memory config with a hypothesis, and the harness keeps it only if it beats the incumbent on the <strong>dev</strong> split.
          </p>
        </div>
        {list.length > 1 && (
          <label className="evo-pick">
            <span className="muted small">Run</span>
            <select className="mono" value={run?._id} onChange={(e) => setPick(e.target.value)}>
              {list.map((r) => (
                <option key={r._id} value={r._id}>
                  {r._id.replace(/^tune:/, "")} · {r.status}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <FixtureNote data={[runs.data]} />

      {!run ? (
        <div className="empty empty-card">
          <strong>Self-tuning hasn’t run yet.</strong>
          <span>
            Start it with <code>uv run python -m hindsight.pipeline.tune --rounds 5 --start hybrid_all</code>. Each round appears here as it finishes.
          </span>
        </div>
      ) : (
        <RunView run={run} cfgById={cfgById} />
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`status-pill status-pill-${status === "running" ? "running" : "done"}`}>
      {status === "running" && <span className="status-pulse" aria-hidden />}
      {status}
    </span>
  );
}

/** For each step, the incumbent (best accepted config) it was measured against. */
function incumbents(steps: TuningStep[]): (TuningStep | undefined)[] {
  let inc: TuningStep | undefined;
  return steps.map((s, i) => {
    const before = inc;
    if (i === 0 || s.accepted) inc = s;
    return before;
  });
}

function RunView({ run, cfgById }: { run: TuningRun; cfgById: Map<string, HarnessConfig> }) {
  const steps = run.steps ?? [];
  const incs = incumbents(steps);
  const start = steps[0];
  const best = steps.find((s) => s.config_id === run.best) ?? start;
  const gain = best && start ? best.dev_pass_at_1 - start.dev_pass_at_1 : 0;
  const accepted = steps.slice(1).filter((s) => s.accepted).length;

  return (
    <>
      <div className="evo-meta">
        <span>
          <span className="muted">run</span> <span className="mono">{run._id.replace(/^tune:/, "")}</span>
        </span>
        {run.created_at && (
          <span>
            <span className="muted">started</span> {fmtDate(run.created_at)} {fmtTime(run.created_at)} UTC
          </span>
        )}
        <span>
          <span className="muted">dev</span> {run.dev_cases?.length ?? 0} cases · <span className="muted">test</span> {run.test_cases?.length ?? 0} cases
        </span>
        <span>
          {steps.length - 1} proposal{steps.length === 2 ? "" : "s"} · {accepted} accepted
        </span>
        {steps.length > 1 && (
          <span>
            <span className="muted">dev pass@1</span> {pct(start?.dev_pass_at_1)} → <strong>{pct(best?.dev_pass_at_1)}</strong>{" "}
            <span className={gain > 0 ? "pos-ink" : "muted"}>({pts(gain)} pts)</span>
          </span>
        )}
        {run.status === "running" && !STATIC && <span className="muted">refreshing every {POLL_MS / 1000} s</span>}
      </div>

      <div className="grid-evo">
        <Panel
          title="Dev pass@1 per step"
          aside={
            <div className="legend">
              <span className="legend-item">
                <span className="sw sw-inc" /> incumbent
              </span>
              <span className="legend-item">
                <span className="dot-acc" /> accepted
              </span>
              <span className="legend-item">
                <span className="dot-rej" /> rejected
              </span>
              <span className="legend-item">
                <span className="sw sw-recall" /> evidence recall
              </span>
            </div>
          }
        >
          <DevChart steps={steps} running={run.status === "running"} />
        </Panel>
        <TestPanel run={run} cfgById={cfgById} />
      </div>

      <Panel title="Trajectory" aside={<span className="muted">knob changes vs. the incumbent at that step</span>}>
        <ol className="traj">
          {steps.map((s, i) => (
            <StepCard key={s.config_id + i} step={s} i={i} inc={incs[i]} isBest={s.config_id === run.best} cfg={cfgById.get(s.config_id)} />
          ))}
          {run.status === "running" && (
            <li className="traj-item traj-pending">
              <span className="traj-dot" aria-hidden />
              <div className="traj-card">
                <span className="spinner" aria-hidden /> Proposing and evaluating step {steps.length}…
              </div>
            </li>
          )}
        </ol>
      </Panel>
    </>
  );
}

// ------------------------------------------------------------------ dev chart (SVG, one % axis)
function DevChart({ steps, running }: { steps: TuningStep[]; running: boolean }) {
  const W = 620,
    H = 250,
    L = 40,
    R = 16,
    T = 16,
    B = 30;
  const n = Math.max(steps.length + (running ? 1 : 0), 2);
  const x = (i: number) => L + (i * (W - L - R)) / (n - 1);
  const y = (v: number) => T + (1 - v) * (H - T - B);
  const incs = incumbents(steps);
  // incumbent after each step (what the next proposal must beat)
  const incAfter = steps.map((s, i) => (i === 0 || s.accepted ? s : incs[i]!));
  let stair = "";
  incAfter.forEach((s, i) => {
    stair += i === 0 ? `M${x(0)},${y(s.dev_pass_at_1)}` : `H${x(i)}V${y(s.dev_pass_at_1)}`;
  });
  if (steps.length) stair += `H${x(running ? steps.length : steps.length - 1)}`;
  const recall = steps.map((s, i) => `${i ? "L" : "M"}${x(i)},${y(s.dev_evidence_recall)}`).join("");
  const [hover, setHover] = useState<number>();

  return (
    <svg className="devchart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Dev pass@1 per tuning step with the incumbent line">
      {[0, 0.25, 0.5, 0.75, 1].map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className={t === 0 ? "dc-base" : "dc-grid"} />
          <text x={L - 6} y={y(t) + 4} className="dc-axis" textAnchor="end">
            {t * 100}%
          </text>
        </g>
      ))}
      {steps.map((_, i) => (
        <text key={i} x={x(i)} y={H - 10} className="dc-axis" textAnchor="middle">
          {i === 0 ? "start" : `#${i}`}
        </text>
      ))}
      {running && (
        <text x={x(steps.length)} y={H - 10} className="dc-axis" textAnchor="middle">
          …
        </text>
      )}
      <path d={recall} className="dc-recall" />
      <path d={stair} className="dc-inc" />
      {steps.map((s, i) => {
        const acc = i === 0 || s.accepted;
        const inc = incs[i];
        const d = inc ? s.dev_pass_at_1 - inc.dev_pass_at_1 : null;
        return (
          <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(undefined)} className="dc-pt">
            <circle cx={x(i)} cy={y(s.dev_pass_at_1)} r={16} className="dc-hit" />
            <circle cx={x(i)} cy={y(s.dev_pass_at_1)} r={6} className={acc ? "dc-acc" : "dc-rej"} />
            <text x={x(i)} y={y(s.dev_pass_at_1) + (acc ? -12 : 20)} className="dc-val" textAnchor="middle">
              {pct(s.dev_pass_at_1)}
            </text>
            {hover === i && (
              <text x={Math.min(Math.max(x(i), L + 90), W - R - 90)} y={T + 10} className="dc-tip" textAnchor="middle">
                {configName(s.config_id)} · pass@1 {pct(s.dev_pass_at_1)}
                {d != null ? ` (${pts(d)} vs incumbent)` : ""} · recall {pct(s.dev_evidence_recall)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ------------------------------------------------------------------ held-out test
function TestPanel({ run, cfgById }: { run: TuningRun; cfgById: Map<string, HarnessConfig> }) {
  const test = run.test;
  const order = [...new Set(["repo_only", run.start, run.best])].filter((c) => test?.[c]);
  const role = (c: string) => (c === "repo_only" ? "no memory" : c === run.start && c !== run.best ? "start config" : c === run.best ? "best tuned" : "");
  const start = test?.[run.start];
  const best = test?.[run.best];
  return (
    <Panel title="Held-out test" aside={<span className="muted">{run.test_cases?.length ?? 0} later-cutoff cases</span>}>
      <p className="evo-note">
        Tuned on <strong>earlier cutoffs</strong> (dev, {run.dev_cases?.length ?? 0} cases); reported on <strong>later cutoffs</strong> (test) the tuner
        never saw.
      </p>
      {!test || !order.length ? (
        <div className="empty evo-test-empty">
          {run.status === "running" ? "Test runs after the last tuning round." : "No held-out test results on this run."}
        </div>
      ) : (
        <>
          <div className="testbars">
            {order.map((c) => {
              const t = test[c];
              return (
                <div key={c} className={`testbar${c === run.best && c !== run.start ? " testbar-best" : ""}`}>
                  <div className="testbar-label">
                    <span className="mono">{configName(c)}</span>
                    <span className="muted small" title={cfgById.get(c)?.label}>
                      {role(c)}
                    </span>
                  </div>
                  <div
                    className="gapbar"
                    title={`pass@1 ${pct(t.pass_at_1)} · evidence recall ${pct(t.evidence_recall)} · n=${t.n_runs} runs`}
                  >
                    <div className="gapbar-grid" />
                    {c !== "repo_only" && <div className="gapbar-found" style={{ width: `${t.evidence_recall * 100}%` }} />}
                    <div className="gapbar-p3" style={{ width: `${t.pass_at_1 * 100}%` }} />
                  </div>
                  <div className="testbar-val">
                    {pct(t.pass_at_1)}
                    <span className="muted small"> n={t.n_runs}</span>
                  </div>
                </div>
              );
            })}
          </div>
          {start && best && run.best !== run.start && (
            <div className={`evo-verdict ${best.pass_at_1 > start.pass_at_1 ? "pos" : "neg"}`}>
              <strong>{pts(best.pass_at_1 - start.pass_at_1)} pts</strong> test pass@1 for {configName(run.best)} over {run.start}
              {best.pass_at_1 <= start.pass_at_1 && ": the dev gain didn’t transfer"}
            </div>
          )}
          <div className="legend small">
            <span className="legend-item">
              <span className="sw sw-p3" /> test pass@1
            </span>
            <span className="legend-item">
              <span className="sw sw-found" /> evidence recall
            </span>
          </div>
        </>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ step card
function StepCard({ step, i, inc, isBest, cfg }: { step: TuningStep; i: number; inc?: TuningStep; isBest: boolean; cfg?: HarnessConfig }) {
  const state = i === 0 ? "start" : step.accepted ? "accepted" : "rejected";
  const d = inc ? step.dev_pass_at_1 - inc.dev_pass_at_1 : null;
  const knobs = KNOBS.map((k) => {
    const now = fmtKnob(knobValue(step.config, k.key));
    const was = inc ? fmtKnob(knobValue(inc.config, k.key)) : now;
    return { ...k, now, was, changed: !!inc && now !== was };
  });
  const changed = knobs.filter((k) => k.changed);
  const same = knobs.filter((k) => !k.changed);
  return (
    <li className={`traj-item traj-${state}`}>
      <span className="traj-dot" aria-hidden>
        {state === "accepted" ? "✓" : state === "rejected" ? "✕" : "●"}
      </span>
      <div className="traj-card">
        <div className="traj-main">
          <div className="traj-head">
            <span className="traj-step">{i === 0 ? "Start" : `Step ${i}`}</span>
            <span className="mono traj-id" title={step.config_id}>
              {configName(step.config_id)}
            </span>
            {cfg?.label && cfg.label !== configName(step.config_id) && <span className="muted small">{cfg.label}</span>}
            <span className={`traj-badge traj-badge-${state}`}>{state}</span>
            {isBest && <span className="badge-best">best</span>}
          </div>
          {i > 0 && <blockquote className="traj-hypo">{step.hypothesis}</blockquote>}
          <div className="knobs">
            {changed.map((k) => (
              <span key={k.key} className="knob knob-changed">
                <span className="knob-k">{k.label}</span> <s>{k.was}</s> → <strong>{k.now}</strong>
              </span>
            ))}
            {same.map((k) => (
              <span key={k.key} className="knob">
                <span className="knob-k">{k.label}</span> {k.now}
              </span>
            ))}
          </div>
        </div>
        <div className="traj-score">
          <div className="traj-p1">{pct(step.dev_pass_at_1)}</div>
          <div className="muted small">dev pass@1</div>
          {d != null && (
            <div className={`traj-delta ${d > 0 ? "pos" : d < 0 ? "neg" : ""}`}>
              {pts(d)} pts <span className="muted">vs incumbent</span>
            </div>
          )}
          <div className="muted small">
            recall {pct(step.dev_evidence_recall)} · n={step.dev_runs}
          </div>
        </div>
      </div>
    </li>
  );
}
