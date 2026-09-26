import { getConfigs, getLeaderboard } from "../api";
import { ErrorBox, FixtureNote, Loading, Meter, Panel } from "../components/ui";
import { pct, pts, SCENARIO_LABEL, SCENARIOS, useAsync, usd } from "../lib";
import type { HarnessConfig, LeaderboardRow, SliceStats } from "../types";

export default function Leaderboard({ repo }: { repo: string }) {
  const lb = useAsync(() => getLeaderboard(repo), [repo]);
  const cfgs = useAsync(() => getConfigs(), []);

  if (lb.error) return <ErrorBox error={lb.error} retry={lb.reload} />;
  if (!lb.data) return <Loading what="leaderboard" />;
  const rows = lb.data;
  if (!rows.length)
    return (
      <div className="empty empty-card">
        <strong>No runs yet for {repo}.</strong>
        <span>The leaderboard fills in once cases are validated and the sweep runs.</span>
      </div>
    );

  const cfgById = new Map((cfgs.data ?? []).map((c) => [c._id, c]));
  const best = [...rows].sort((a, b) => b.pass_at_1 - a.pass_at_1 || b.pass_pow_3 - a.pass_pow_3)[0];
  const maxCases = Math.max(...rows.map((r) => r.n_cases));
  const horizons = Object.keys(rows[0].by_horizon ?? {}).sort((a, b) => +a - +b);
  const runsPerCase = rows[0].n_cases ? Math.round(rows[0].n_runs / rows[0].n_cases / Math.max(1, horizons.length)) : 0;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Memory configs, head to head</h1>
          <p className="lede">
            Same pi agent, same tasks, same cutoffs; only the memory design changes. <span className="pill">pilot</span>{" "}
            {maxCases} cases × {horizons.length || 1} horizon{horizons.length === 1 ? "" : "s"} ({horizons.map((h) => `${h}d`).join(", ")}) × {runsPerCase}{" "}
            repeats per config.
          </p>
        </div>
      </div>

      <FixtureNote data={[lb.data, cfgs.data]} />
      <Panel
        className="panel-flush"
        title="Leaderboard"
        aside={
          <div className="legend">
            <span className="legend-item">
              <span className="sw sw-p1" /> pass@1: mean pass rate over repeats
            </span>
            <span className="legend-item">
              <span className="sw sw-p3" /> pass^3: case passed in all 3 repeats
            </span>
          </div>
        }
      >
        <table className="lb">
          <thead>
            <tr>
              <th className="col-config">Config</th>
              <th className="num">pass@1</th>
              <th className="num">pass^3</th>
              <th className="col-bar">
                <span className="axis-labels">
                  <span>0</span>
                  <span>50%</span>
                  <span>100%</span>
                </span>
              </th>
              <th className="num" title="Share of runs where memory returned any gold evidence id">
                Evidence recall
              </th>
              <th className="num" title="Share of runs where pi called search_memory">
                Memory-tool use
              </th>
              <th className="num">$ / run</th>
              <th className="num">n</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={r.config_id} r={r} cfg={cfgById.get(r.config_id)} best={r === best} />
            ))}
          </tbody>
        </table>
      </Panel>

      <Ablations rows={rows} />

      <div className="grid-2">
        <Breakdown
          title="By scenario"
          rows={rows}
          cols={SCENARIOS.filter((s) => rows.some((r) => r.by_scenario?.[s])).map((s) => ({ key: s, label: SCENARIO_LABEL[s] }))}
          get={(r, k) => r.by_scenario?.[k]}
          best={best.config_id}
        />
        <Breakdown
          title="By horizon"
          rows={rows}
          cols={horizons.map((h) => ({ key: h, label: `${h}-day horizon` }))}
          get={(r, k) => r.by_horizon?.[k]}
          best={best.config_id}
        />
      </div>
    </div>
  );
}

function configFlags(c?: HarnessConfig): string[] {
  if (!c) return [];
  if (!c.memory) return ["no memory extension"];
  const f = [c.retrieval ?? "", c.source ?? ""];
  if (c.k) f.push(`k=${c.k}`);
  if (c.briefing) f.push("briefing");
  f.push(c.drop_superseded ? "drop superseded" : "keeps superseded");
  if (c.recency_weight) f.push(`recency ${c.recency_weight}`);
  return f.filter(Boolean);
}

function Row({ r, cfg, best }: { r: LeaderboardRow; cfg?: HarnessConfig; best: boolean }) {
  const gap = r.pass_at_1 - r.pass_pow_3;
  const noMem = cfg?.memory === false || r.config_id === "repo_only" || r.evidence_recall == null;
  return (
    <tr className={best ? "row-best" : ""}>
      <td className="col-config">
        <div className="cfg-label">
          {r.label}
          {best && <span className="badge-best">best</span>}
        </div>
        <div className="cfg-meta">
          <span className="mono">{r.config_id}</span>
          {configFlags(cfg).map((f) => (
            <span key={f} className={`flag${f === "keeps superseded" ? " flag-warn" : ""}`}>
              {f}
            </span>
          ))}
        </div>
      </td>
      <td className="num big">{pct(r.pass_at_1)}</td>
      <td className="num big strong">{pct(r.pass_pow_3)}</td>
      <td className="col-bar">
        <div className="gapbar" title={`pass@1 ${pct(r.pass_at_1)} · pass^3 ${pct(r.pass_pow_3)} · gap ${Math.round(gap * 100)} pts`}>
          <div className="gapbar-grid" />
          <div className="gapbar-p1" style={{ width: `${r.pass_at_1 * 100}%` }} />
          <div className="gapbar-p3" style={{ width: `${r.pass_pow_3 * 100}%` }} />
          {gap >= 0.08 && (
            <div className="gapbar-label" style={{ left: `${r.pass_pow_3 * 100}%`, width: `${gap * 100}%` }}>
              −{Math.round(gap * 100)}
            </div>
          )}
        </div>
      </td>
      <td className="num">
        {noMem ? (
          <span className="muted">—</span>
        ) : (
          <div className="num-meter">
            {pct(r.evidence_recall)}
            <Meter value={r.evidence_recall} />
          </div>
        )}
      </td>
      <td className="num">
        {noMem ? (
          <span className="muted">—</span>
        ) : (
          <div className="num-meter">
            {pct(r.memory_tool_use)}
            <Meter value={r.memory_tool_use} />
          </div>
        )}
      </td>
      <td className="num">{usd(r.cost_usd_per_run)}</td>
      <td className="num n-cell">
        {r.n_cases} cases
        <br />
        <span className="muted">{r.n_runs} runs</span>
      </td>
    </tr>
  );
}

// ------------------------------------------------------------------ ablations
const ABLATIONS: { from: string; to: string; label: string; focus?: string }[] = [
  { from: "hybrid_all_brief", to: "ablate_superseded", label: "Turning off superseded filtering", focus: "superseded_decision" },
  { from: "hybrid_all", to: "hybrid_all_brief", label: "Adding the briefing" },
  { from: "hybrid_turns", to: "hybrid_all", label: "Adding extracted moments to raw turns" },
  { from: "vector_turns", to: "hybrid_turns", label: "Fusing BM25 with vector search" },
  { from: "repo_only", to: "__best__", label: "Memory vs. no memory" },
];

function Ablations({ rows }: { rows: LeaderboardRow[] }) {
  const by = new Map(rows.map((r) => [r.config_id, r]));
  const best = [...rows].filter((r) => r.config_id !== "repo_only").sort((a, b) => b.pass_at_1 - a.pass_at_1)[0];
  const items = ABLATIONS.map((a) => ({ ...a, A: by.get(a.from), B: a.to === "__best__" ? best : by.get(a.to) })).filter(
    (a) => a.A && a.B && a.A !== a.B,
  );
  if (!items.length) return null;
  return (
    <Panel title="Ablations" aside={<span className="muted">Δ in percentage points, same cases and cutoffs</span>}>
      <div className="ablations">
        {items.map(({ label, A, B, focus }) => {
          const d1 = B!.pass_at_1 - A!.pass_at_1;
          const d3 = B!.pass_pow_3 - A!.pass_pow_3;
          const fa = focus ? A!.by_scenario?.[focus] : undefined;
          const fb = focus ? B!.by_scenario?.[focus] : undefined;
          return (
            <div key={label} className={`abl ${d1 < 0 ? "abl-neg" : "abl-pos"}`}>
              <div className="abl-label">{label}</div>
              <div className="abl-delta">
                <span className="abl-arrow" aria-hidden>
                  {d1 < 0 ? "▼" : "▲"}
                </span>
                {pts(d1)}
                <span className="abl-unit"> pts pass@1</span>
              </div>
              <div className="abl-sub">
                {pts(d3)} pts pass^3
                {fa && fb && (
                  <>
                    {" · "}
                    <strong>{pts(fb.pass_at_1 - fa.pass_at_1)}</strong> on {SCENARIO_LABEL[focus as keyof typeof SCENARIO_LABEL].toLowerCase()}s
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

// ------------------------------------------------------------------ breakdown heat tables
function Breakdown({
  title,
  rows,
  cols,
  get,
  best,
}: {
  title: string;
  rows: LeaderboardRow[];
  cols: { key: string; label: string }[];
  get: (r: LeaderboardRow, k: string) => SliceStats | undefined;
  best: string;
}) {
  return (
    <Panel title={title} aside={<span className="muted">pass@1 · pass^3 · n cases</span>}>
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
              <th className="mono">{r.config_id}</th>
              {cols.map((c) => {
                const s = get(r, c.key);
                if (!s || s.pass_at_1 == null) return <td key={c.key} className="muted">—</td>;
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
