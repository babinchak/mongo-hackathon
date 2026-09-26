// Self-tuning visuals shared by Evolution (#/evolution) and the Overview's "harness tuned itself" panel.
import { useState } from "react";
import { configName, pct, pts } from "../lib";
import type { HarnessConfig, TuningKnobs, TuningRun, TuningStep } from "../types";

export const KNOBS: { key: keyof TuningKnobs; label: string }[] = [
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
export const knobValue = (c: TuningKnobs | undefined, k: keyof TuningKnobs) => c?.[k] ?? DEFAULTS[k];
export const fmtKnob = (v: unknown) =>
  v == null ? "default" : typeof v === "boolean" ? (v ? "on" : "off") : String(v).replace("_", " ");

/** For each step, the incumbent (best accepted config) it was measured against. */
export function incumbents(steps: TuningStep[]): (TuningStep | undefined)[] {
  let inc: TuningStep | undefined;
  return steps.map((s, i) => {
    const before = inc;
    if (i === 0 || s.accepted) inc = s;
    return before;
  });
}

export interface KnobChange {
  key: keyof TuningKnobs;
  label: string;
  was: string;
  now: string;
  changed: boolean;
}

/** Every knob of `step`, compared with the incumbent it had to beat. */
export function knobChanges(step: TuningStep, inc: TuningStep | undefined): KnobChange[] {
  return KNOBS.map((k) => {
    const now = fmtKnob(knobValue(step.config, k.key));
    const was = inc ? fmtKnob(knobValue(inc.config, k.key)) : now;
    return { ...k, now, was, changed: !!inc && now !== was };
  });
}

/** The latest tuning run that has held-out test results (else the latest run). Runs arrive newest first. */
export const latestTunedRun = (runs: TuningRun[] | undefined) => runs?.find((r) => r.test?.[r.best]) ?? runs?.[0];

// ------------------------------------------------------------------ dev chart (SVG, one % axis)
/**
 * Dev pass@1 per step with the incumbent staircase. `w` / `h` set the viewBox: keep them close to the
 * rendered size so the labels stay legible (the SVG scales with its container).
 */
export function DevChart({ steps, running, w = 620, h = 250 }: { steps: TuningStep[]; running: boolean; w?: number; h?: number }) {
  const W = w,
    H = h,
    L = 40,
    R = 16,
    T = 16,
    B = 30;
  const n = Math.max(steps.length + (running ? 1 : 0), 2);
  // Points sit a little inside the plot so the first value label clears the y-axis labels.
  const P = 14;
  const x = (i: number) => L + P + (i * (W - L - R - 2 * P)) / (n - 1);
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

export function DevLegend() {
  return (
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
  );
}

// ------------------------------------------------------------------ held-out test bars
/** Configs shown in the held-out comparison, in reading order: no memory, the start config, the best tuned one. */
export const testOrder = (run: TuningRun) => [...new Set(["repo_only", run.start, run.best])].filter((c) => run.test?.[c]);

export function testRole(run: TuningRun, c: string) {
  return c === "repo_only" ? "no memory" : c === run.start && c !== run.best ? "start config" : c === run.best ? "best tuned" : "";
}

/**
 * Test pass@1 (solid) over evidence recall (dashed) per config. Renders nothing without test results.
 * `roleFirst` leads with the role ("no memory", "best tuned") and puts the config id underneath.
 */
export function TestBars({ run, cfgById, roleFirst }: { run: TuningRun; cfgById?: Map<string, HarnessConfig>; roleFirst?: boolean }) {
  const test = run.test;
  if (!test) return null;
  return (
    <div className="testbars">
      {testOrder(run).map((c) => {
        const t = test[c];
        return (
          <div key={c} className={`testbar${c === run.best && c !== run.start ? " testbar-best" : ""}`}>
            {roleFirst ? (
              <div className="testbar-label testbar-label-role" title={configName(c)}>
                <span>{testRole(run, c)}</span>
                <span className="mono muted small">{configName(c)}</span>
              </div>
            ) : (
              <div className="testbar-label">
                <span className="mono">{configName(c)}</span>
                <span className="muted small" title={cfgById?.get(c)?.label}>
                  {testRole(run, c)}
                </span>
              </div>
            )}
            <div className="gapbar" title={`pass@1 ${pct(t.pass_at_1)} · evidence recall ${pct(t.evidence_recall)} · n=${t.n_runs} runs`}>
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
  );
}

export function TestLegend() {
  return (
    <div className="legend small">
      <span className="legend-item">
        <span className="sw sw-p3" /> test pass@1
      </span>
      <span className="legend-item">
        <span className="sw sw-found" /> evidence recall
      </span>
    </div>
  );
}
