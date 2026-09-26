import { useEffect, useState } from "react";
import { getConfigs, getTuning, STATIC } from "../api";
import { DevChart, DevLegend, incumbents, knobChanges, TestBars, TestLegend, testOrder } from "../components/tuning";
import { ErrorBox, FixtureNote, Loading, Panel } from "../components/ui";
import { configName, fmtDate, fmtTime, pct, pts, useAsync } from "../lib";
import type { HarnessConfig, TuningRun, TuningStep } from "../types";

const POLL_MS = 15_000;

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
        <Panel title="Dev pass@1 per step" aside={<DevLegend />}>
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

// ------------------------------------------------------------------ held-out test
function TestPanel({ run, cfgById }: { run: TuningRun; cfgById: Map<string, HarnessConfig> }) {
  const test = run.test;
  const order = testOrder(run);
  const start = test?.[run.start];
  const best = test?.[run.best];
  return (
    <Panel title="Held-out test" aside={<span className="muted">{run.test_cases?.length ?? 0} later-cutoff cases</span>}>
      <p className="evo-note">
        Tuned on <strong>earlier cutoffs</strong> (dev, {run.dev_cases?.length ?? 0} cases); reported on <strong>later cutoffs</strong> (test) the tuner
        never saw. These bars are the tuner’s own check at the +7 day horizon; the Overview reports the same cases across every horizon.
      </p>
      {!test || !order.length ? (
        <div className="empty evo-test-empty">
          {run.status === "running" ? "Test runs after the last tuning round." : "No held-out test results on this run."}
        </div>
      ) : (
        <>
          <TestBars run={run} cfgById={cfgById} />
          {start && best && run.best !== run.start && (
            <div className={`evo-verdict ${best.pass_at_1 > start.pass_at_1 ? "pos" : "neg"}`}>
              <strong>{pts(best.pass_at_1 - start.pass_at_1)} pts</strong> test pass@1 for {configName(run.best)} over {run.start}
              {best.pass_at_1 <= start.pass_at_1 && ": the dev gain didn’t transfer"}
            </div>
          )}
          <TestLegend />
        </>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ step card
function StepCard({ step, i, inc, isBest, cfg }: { step: TuningStep; i: number; inc?: TuningStep; isBest: boolean; cfg?: HarnessConfig }) {
  const state = i === 0 ? "start" : step.accepted ? "accepted" : "rejected";
  const d = inc ? step.dev_pass_at_1 - inc.dev_pass_at_1 : null;
  const knobs = knobChanges(step, inc);
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
