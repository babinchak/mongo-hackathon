import type { ReactNode } from "react";
import { getConfigs, getJudgeAudit, getLeaderboard, getSpend } from "../api";
import { ErrorBox, FixtureNote, Loading, Meter, Panel } from "../components/ui";
import { configFlags, configName, isTuned, pct, pts, runsHref, SCENARIO_LABEL, SCENARIOS, useAsync, usd } from "../lib";
import type { HarnessConfig, JudgeAudit, LeaderboardRow, SliceStats, Spend } from "../types";

/** repo undefined = every repo. */
export default function Leaderboard({ repo }: { repo?: string }) {
  const lb = useAsync(() => getLeaderboard(repo), [repo]);
  const cfgs = useAsync(() => getConfigs(), []);
  const spend = useAsync(() => getSpend(), []);
  const judge = useAsync(() => getJudgeAudit(), []);

  if (lb.error) return <ErrorBox error={lb.error} retry={lb.reload} />;
  if (!lb.data) return <Loading what="leaderboard" />;
  const rows = lb.data;
  if (!rows.length)
    return (
      <div className="empty empty-card">
        <strong>No runs yet for {repo ?? "any repo"}.</strong>
        <span>The leaderboard fills in once cases are validated and the sweep runs.</span>
      </div>
    );

  const cfgById = new Map((cfgs.data ?? []).map((c) => [c._id, c]));
  const maxCases = Math.max(...rows.map((r) => r.n_cases));
  // Fair comparisons only between configs scored on the full case set (tuned configs only see the dev split).
  const full = rows.filter((r) => !isTuned(r.config_id));
  const best = [...(full.length ? full : rows)].sort((a, b) => b.pass_at_1 - a.pass_at_1 || b.pass_pow_3 - a.pass_pow_3)[0];
  const horizons = [...new Set(rows.flatMap((r) => Object.keys(r.by_horizon ?? {})))].sort((a, b) => +a - +b);
  const ks = [...new Set(rows.map((r) => r.k).filter((k): k is number => k != null))];
  const kLabel = ks.length === 1 ? `pass^${ks[0]}` : "pass^k";
  const maxK = ks.length ? Math.max(...ks) : 3;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Memory configs, head to head</h1>
          <p className="lede">
            Same pi agent, same tasks, same cutoffs; only the memory design changes.{" "}
            <strong>{repo ? <span className="mono">{repo}</span> : "All repos"}</strong>: {maxCases} cases × {horizons.length || 1} horizon
            {horizons.length === 1 ? "" : "s"} ({horizons.map((h) => `+${h}d`).join(", ")}) × up to {maxK} repeats per config.
          </p>
        </div>
      </div>

      <FixtureNote data={[lb.data, cfgs.data]} />

      <Headlines rows={full} best={best} kLabel={kLabel} />

      <Panel
        className="panel-flush"
        title="Leaderboard"
        aside={
          <div className="legend">
            <span className="legend-item" title="Share of runs where memory returned the gold evidence">
              <span className="sw sw-found" /> found: memory returned the gold evidence
            </span>
            <span className="legend-item">
              <span className="sw sw-p1" /> pass@1: mean pass rate
            </span>
            <span className="legend-item">
              <span className="sw sw-p3" /> {kLabel}: passed all {ks.length === 1 ? ks[0] : "k"} repeats
            </span>
          </div>
        }
      >
        <table className="lb">
          <thead>
            <tr>
              <th className="col-config">Config</th>
              <th className="num">pass@1</th>
              <th className="num" title="Share of (case, cutoff) units that passed in every one of their k repeats">
                {kLabel}
              </th>
              <th className="col-bar">
                <div className="bar-head">
                  <span>Found vs. used</span>
                  <span className="axis-labels">
                    <span>0</span>
                    <span>50%</span>
                    <span>100%</span>
                  </span>
                </div>
              </th>
              <th className="num" title="Share of runs where memory returned any gold evidence id">
                Evidence
                <br />
                recall
              </th>
              <th className="num" title="Share of runs where pi called search_memory">
                Memory
                <br />
                tool use
              </th>
              <th className="num">$ / run</th>
              <th className="num">n</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={r.config_id} r={r} cfg={cfgById.get(r.config_id)} best={r === best} uniformK={ks.length === 1} />
            ))}
          </tbody>
        </table>
      </Panel>

      <Horizons rows={rows} horizons={horizons} kLabel={kLabel} best={best.config_id} />

      <div className="grid-2">
        <Ablations rows={full} />
        <Breakdown
          title="By scenario"
          rows={rows}
          cols={SCENARIOS.filter((s) => rows.some((r) => r.by_scenario?.[s])).map((s) => ({ key: s, label: SCENARIO_LABEL[s] }))}
          get={(r, k) => r.by_scenario?.[k]}
          best={best.config_id}
          kLabel={kLabel}
        />
      </div>

      <Footer spend={spend.data} judge={judge.data} />
    </div>
  );
}

const noMemory = (r: LeaderboardRow, cfg?: HarnessConfig) => cfg?.memory === false || r.config_id === "repo_only" || r.evidence_recall == null;

function Row({ r, cfg, best, uniformK }: { r: LeaderboardRow; cfg?: HarnessConfig; best: boolean; uniformK: boolean }) {
  const noMem = noMemory(r, cfg);
  const tuned = isTuned(r.config_id) || cfg?.tuned;
  const recall = noMem ? null : r.evidence_recall;
  const unused = recall != null ? recall - r.pass_at_1 : 0;
  const relGap = r.pass_at_1 - r.pass_pow_3;
  const k = r.k ?? 3;
  return (
    <tr className={`${best ? "row-best" : ""}${tuned ? " row-tuned" : ""}`}>
      <td className="col-config">
        <div className="cfg-label">
          {tuned && (
            <span className="badge-tuned" title="Proposed by the self-tuning harness">
              ✦ tuned
            </span>
          )}
          <a className="cfg-link" href={runsHref(r.config_id)} title="Browse this config’s runs and their traces">
            {r.label}
          </a>
          {best && <span className="badge-best">best</span>}
          <a className="lb-inspect" href={runsHref(r.config_id)}>
            Inspect runs →
          </a>
        </div>
        <div className="cfg-meta">
          <span className="mono" title={r.config_id}>
            {configName(r.config_id)}
          </span>
          {configFlags(cfg).map((f) => (
            <span key={f} className={`flag${f === "keeps superseded" ? " flag-warn" : ""}`}>
              {f}
            </span>
          ))}
        </div>
        {tuned && cfg?.hypothesis && (
          <div className="cfg-hypo" title={cfg.hypothesis}>
            “{cfg.hypothesis}”
          </div>
        )}
      </td>
      <td className="num big">{pct(r.pass_at_1)}</td>
      <td className="num big strong">
        {pct(r.pass_pow_3)}
        {!uniformK && <span className="k-sub">pass^{k}</span>}
      </td>
      <td className="col-bar">
        <div
          className="gapbar"
          title={[
            recall != null ? `found (evidence recall) ${pct(recall)}` : "no memory",
            `pass@1 ${pct(r.pass_at_1)}`,
            `pass^${k} ${pct(r.pass_pow_3)}`,
            recall != null ? `found but not used: ${Math.round(unused * 100)} pts` : "",
            `reliability gap: ${Math.round(relGap * 100)} pts`,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <div className="gapbar-grid" />
          {recall != null && <div className="gapbar-found" style={{ width: `${recall * 100}%` }} />}
          <div className="gapbar-p1" style={{ width: `${r.pass_at_1 * 100}%` }} />
          <div className="gapbar-p3" style={{ width: `${r.pass_pow_3 * 100}%` }} />
          {recall != null && unused >= 0.1 && (
            <div className="gapbar-label gapbar-unused" style={{ left: `${r.pass_at_1 * 100}%`, width: `${unused * 100}%` }}>
              {unused >= 0.4 ? `${Math.round(unused * 100)} pts found, not used` : unused >= 0.26 ? `${Math.round(unused * 100)} unused` : Math.round(unused * 100)}
            </div>
          )}
        </div>
      </td>
      <td className="num">
        {noMem ? (
          <span className="muted">-</span>
        ) : (
          <div className="num-meter">
            {pct(r.evidence_recall)}
            <Meter value={r.evidence_recall} />
          </div>
        )}
      </td>
      <td className="num">{noMem ? <span className="muted">-</span> : pct(r.memory_tool_use)}</td>
      <td className="num">{usd(r.cost_usd_per_run)}</td>
      <td className="num n-cell">
        {r.n_cases} cases
        {r.n_units != null && <> · {r.n_units} units</>}
        <br />
        <span className="muted">{r.n_runs} runs</span>
      </td>
    </tr>
  );
}

// ------------------------------------------------------------------ headline findings (computed from the rows)
function Headlines({ rows, best, kLabel }: { rows: LeaderboardRow[]; best: LeaderboardRow; kLabel: string }) {
  const by = new Map(rows.map((r) => [r.config_id, r]));
  const repo = by.get("repo_only");
  const mem = rows.filter((r) => r.config_id !== "repo_only" && r.evidence_recall != null);
  const top = best.config_id !== "repo_only" ? best : [...mem].sort((a, b) => b.pass_at_1 - a.pass_at_1)[0];
  if (!top) return null;
  const cards: { key: string; tone: "pos" | "neg" | "warn"; label: string; big: string; unit: string; sub: ReactNode; pair: string }[] = [];

  if (repo)
    cards.push({
      key: "mem",
      tone: "pos",
      label: "Memory vs. repo-only",
      big: pts(top.pass_at_1 - repo.pass_at_1),
      unit: "pts pass@1",
      sub: (
        <>
          {pct(repo.pass_at_1)} → <strong>{pct(top.pass_at_1)}</strong> with the best memory config
        </>
      ),
      pair: `repo_only → ${top.config_id}`,
    });

  if (top.evidence_recall != null && top.pass_at_1 < 1) {
    // P(found ∧ fail) ≥ recall − pass@1, so this is a lower bound on the share of failures with the gold evidence in hand.
    const share = Math.max(0, Math.min(1, (top.evidence_recall - top.pass_at_1) / (1 - top.pass_at_1)));
    cards.push({
      key: "unused",
      tone: "warn",
      label: "Retrieved, but not used",
      big: share >= 0.995 ? "100%" : `≥${pct(share)}`,
      unit: "of failures",
      sub: (
        <>
          memory found the gold evidence in <strong>{pct(top.evidence_recall)}</strong> of runs; pi passed {pct(top.pass_at_1)}. Retrieval isn’t the
          bottleneck.{" "}
          <a href={runsHref(top.config_id, { unused: "1" })}>See those runs →</a>
        </>
      ),
      pair: top.config_id,
    });
  }

  const decayOf = (r: LeaderboardRow) => {
    const h1 = r.by_horizon?.["1"],
      h21 = r.by_horizon?.["21"];
    return h1 && h21 ? h21.pass_at_1 - h1.pass_at_1 : null;
  };
  const d = decayOf(top);
  if (d != null) {
    const ds = mem.map(decayOf).filter((x): x is number => x != null);
    const mean = ds.reduce((a, b) => a + b, 0) / Math.max(1, ds.length);
    const h = top.by_horizon;
    cards.push({
      key: "horizon",
      tone: d < 0 ? "neg" : "pos",
      label: "Long-horizon decay",
      big: pts(d),
      unit: "pts, +1d → +21d",
      sub: (
        <>
          {["1", "7", "21"]
            .filter((k) => h[k])
            .map((k) => pct(h[k].pass_at_1))
            .join(" → ")}
          {ds.length > 1 && <> · mean over {ds.length} memory configs {pts(mean)}</>}
        </>
      ),
      pair: top.config_id,
    });
  }

  cards.push({
    key: "rel",
    tone: "neg",
    label: "Reliability gap",
    big: pts(top.pass_pow_3 - top.pass_at_1),
    unit: `pts, pass@1 → ${top.k ? `pass^${top.k}` : kLabel}`,
    sub: (
      <>
        {pct(top.pass_at_1)} of runs pass, but only <strong>{pct(top.pass_pow_3)}</strong> of units pass every repeat
      </>
    ),
    pair: top.config_id,
  });

  return (
    <div className="headlines">
      {cards.map((c) => (
        <div key={c.key} className={`abl abl-${c.tone}`}>
          <div className="abl-label">{c.label}</div>
          <div className="abl-delta">
            {c.big}
            <span className="abl-unit"> {c.unit}</span>
          </div>
          <div className="abl-sub">{c.sub}</div>
          <div className="abl-pair mono">{c.pair}</div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ ablations
const ABLATIONS: { from: string; to: string; label: string; focus?: string }[] = [
  { from: "hybrid_turns", to: "hybrid_all", label: "Moments vs. raw turns" },
  { from: "hybrid_all", to: "hybrid_all_brief", label: "Briefing" },
  { from: "hybrid_all_brief", to: "ablate_superseded", label: "Keeping superseded decisions", focus: "superseded_decision" },
  { from: "vector_turns", to: "hybrid_turns", label: "Hybrid vs. vector search" },
];

function Ablations({ rows }: { rows: LeaderboardRow[] }) {
  const by = new Map(rows.map((r) => [r.config_id, r]));
  const items = ABLATIONS.map((a) => ({ ...a, A: by.get(a.from), B: by.get(a.to) })).filter((a) => a.A && a.B);
  if (!items.length) return null;
  return (
    <Panel title="Ablations" aside={<span className="muted">Δ pass@1 in points, same cases and cutoffs</span>}>
      <div className="ablations">
        {items.map(({ label, A, B, focus }) => {
          const d1 = B!.pass_at_1 - A!.pass_at_1;
          const d3 = B!.pass_pow_3 - A!.pass_pow_3;
          const fa = focus ? A!.by_scenario?.[focus] : undefined;
          const fb = focus ? B!.by_scenario?.[focus] : undefined;
          return (
            <div key={label} className={`abl ${Math.abs(d1) < 0.005 ? "" : d1 < 0 ? "abl-neg" : "abl-pos"}`}>
              <div className="abl-label">{label}</div>
              <div className="abl-delta">
                <span className="abl-arrow" aria-hidden>
                  {d1 < 0 ? "▼" : "▲"}
                </span>
                {pts(d1)}
                <span className="abl-unit"> pts</span>
              </div>
              <div className="abl-sub">
                {pct(A!.pass_at_1)} → {pct(B!.pass_at_1)} · {pts(d3)} pass^{B!.k ?? 3}
                {fa && fb && (
                  <>
                    <br />
                    <strong>{pts(fb.pass_at_1 - fa.pass_at_1)}</strong> on {SCENARIO_LABEL[focus as keyof typeof SCENARIO_LABEL].toLowerCase()}s (n=
                    {Math.min(fa.n_cases, fb.n_cases)})
                  </>
                )}
              </div>
              <div className="abl-pair mono">
                {A!.config_id} → {B!.config_id}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ horizon small multiples
function Horizons({ rows, horizons, kLabel, best }: { rows: LeaderboardRow[]; horizons: string[]; kLabel: string; best: string }) {
  const shown = rows.filter((r) => horizons.filter((h) => r.by_horizon?.[h]).length >= 2);
  if (horizons.length < 2 || !shown.length) return null;
  const top = Math.max(0.5, ...shown.flatMap((r) => horizons.map((h) => r.by_horizon?.[h]?.pass_at_1 ?? 0)));
  const scale = Math.ceil(top * 10) / 10;
  return (
    <Panel
      title="By horizon: days between the knowledge and the task"
      aside={
        <div className="legend">
          <span className="legend-item">
            <span className="sw sw-p1" /> pass@1
          </span>
          <span className="legend-item">
            <span className="sw sw-p3" /> {kLabel}
          </span>
          <span className="muted">shared 0–{pct(scale)} scale</span>
        </div>
      }
    >
      <div className="hz-grid">
        {shown.map((r) => {
          const first = r.by_horizon[horizons[0]];
          const last = r.by_horizon[horizons[horizons.length - 1]];
          const d = first && last ? last.pass_at_1 - first.pass_at_1 : null;
          return (
            <div key={r.config_id} className={`hz${r.config_id === best ? " hz-best" : ""}${isTuned(r.config_id) ? " hz-tuned" : ""}`}>
              <div className="hz-head">
                <span className="mono hz-name" title={r.label}>
                  {isTuned(r.config_id) && "✦ "}
                  {configName(r.config_id)}
                </span>
                {d != null && Math.abs(d) >= 0.005 && <span className={`hz-delta ${d < 0 ? "neg" : "pos"}`}>{pts(d)}</span>}
              </div>
              <div className="hz-plot">
                {horizons.map((h) => {
                  const s = r.by_horizon[h];
                  return (
                    <div
                      key={h}
                      className="hz-col"
                      title={s ? `+${h} days · pass@1 ${pct(s.pass_at_1)} · ${kLabel} ${pct(s.pass_pow_3)} · n=${s.n_cases} cases` : `+${h} days: no runs`}
                    >
                      <div className="hz-val">{s ? pct(s.pass_at_1) : "-"}</div>
                      <div className="hz-track">
                        {s && (
                          <>
                            <div className="hz-p1" style={{ height: `${(s.pass_at_1 / scale) * 100}%` }} />
                            <div className="hz-p3" style={{ height: `${(s.pass_pow_3 / scale) * 100}%` }} />
                          </>
                        )}
                      </div>
                      <div className="hz-x">+{h}d</div>
                      <div className="hz-n">{s ? `n=${s.n_cases}` : ""}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ breakdown heat tables
function Breakdown({
  title,
  rows,
  cols,
  get,
  best,
  kLabel,
}: {
  title: string;
  rows: LeaderboardRow[];
  cols: { key: string; label: string }[];
  get: (r: LeaderboardRow, k: string) => SliceStats | undefined;
  best: string;
  kLabel: string;
}) {
  return (
    <Panel title={title} aside={<span className="muted">pass@1 · {kLabel} · n cases</span>}>
      <table className="heat">
        <thead>
          <tr>
            <th />
            {cols.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.config_id} className={r.config_id === best ? "row-best" : ""}>
              <th className="mono" title={r.config_id}>
                {configName(r.config_id)}
              </th>
              {cols.map((c) => {
                const s = get(r, c.key);
                if (!s || s.pass_at_1 == null)
                  return (
                    <td key={c.key} className="muted">
                      -
                    </td>
                  );
                return (
                  <td key={c.key} style={{ ["--heat" as string]: s.pass_at_1 }} className="heat-cell">
                    <span className="heat-main">{pct(s.pass_at_1)}</span>
                    <span className="heat-sub">
                      {pct(s.pass_pow_3)} · n={s.n_cases}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

// ------------------------------------------------------------------ footer: spend + judge audit
function Footer({ spend, judge }: { spend?: Spend; judge?: JudgeAudit }) {
  const agreement = judge?.agreement != null ? (judge.agreement > 1 ? judge.agreement / 100 : judge.agreement) : null;
  if (!spend && agreement == null) return null;
  const llm = spend ? spend.llm.reduce((a, b) => a + b.cost_usd, 0) : 0;
  return (
    <footer className="page-foot">
      {spend && (
        <span title={spend.llm.map((l) => `${l.stage} (${l.model}): ${l.calls} calls, ${usd(l.cost_usd)}`).join("\n")}>
          <strong>{usd(spend.total_usd)}</strong> spent · {spend.pi.runs.toLocaleString()} pi runs ({usd(spend.pi.cost_usd)}) · pipeline LLM calls{" "}
          {usd(llm)}
        </span>
      )}
      {agreement != null && (
        <span title={judge?.judge ? `Judge ${judge.judge}, audited by ${judge.auditor}` : undefined}>
          Judge agreement with {judge?.auditor ?? "auditor"}: <strong>{pct(agreement)}</strong> (n={judge?.n ?? "?"})
        </span>
      )}
    </footer>
  );
}
