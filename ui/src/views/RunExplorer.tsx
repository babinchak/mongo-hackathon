import { useMemo } from "react";
import { getConfigs, getLeaderboard, getRuns } from "../api";
import { ErrorBox, FixtureNote, Loading, VerdictChip } from "../components/ui";
import {
  applyRunFilter,
  configFlags,
  configName,
  fmtDuration,
  href,
  isLive,
  isTuned,
  pct,
  readRunFilter,
  repoShort,
  runFilterParams,
  runHref,
  runsHref,
  setHashQuery,
  sortRuns,
  useAsync,
  useHashQuery,
  usd,
} from "../lib";
import type { HarnessConfig, LeaderboardRow, RunListItem } from "../types";

/** #/runs?config=<id>: every eval run of one config, filterable, each row opening its trace. repo undefined = all repos. */
export default function RunExplorer({ repo }: { repo?: string }) {
  const q = useHashQuery();
  const configId = q.get("config") ?? "";
  const cfgs = useAsync(() => getConfigs(), []);
  const runs = useAsync(() => (configId ? getRuns(configId, { fresh: true }) : Promise.resolve([] as RunListItem[])), [configId]);
  const lb = useAsync(() => getLeaderboard(repo), [repo]);
  const f = readRunFilter(q, repo);

  const all = runs.data ?? [];
  const base = useMemo(() => applyRunFilter(all, f, ["verdict", "h"]), [all, f.repo, f.caseId]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => sortRuns(applyRunFilter(all, f)), [all, f.repo, f.caseId, f.verdict, f.unused, f.h]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!configId) return <ConfigPicker configs={cfgs.data} />;
  if (runs.error) return <ErrorBox error={runs.error} retry={runs.reload} />;
  if (!runs.data) return <Loading what="runs" />;

  const cfg = cfgs.data?.find((c) => c._id === configId);
  const row = lb.data?.find((r) => r.config_id === configId);
  const noMem = cfg?.memory === false;
  const byH = applyRunFilter(base, f, ["h"]);
  const byV = applyRunFilter(base, f, ["verdict"]);
  const horizons = [...new Set(all.map((r) => r.horizon_days))].sort((a, b) => a - b);
  const nPass = byV.filter((r) => r.verdict === "pass").length;
  const nFail = byV.filter((r) => r.verdict === "fail").length;
  const nUnused = byV.filter((r) => r.verdict === "fail" && r.hit_gold).length;
  const params = runFilterParams(f);
  const setF = (u: Record<string, string | undefined>) => setHashQuery(u, { replace: true });
  const caseTask = f.caseId ? all.find((r) => r.case_id === f.caseId)?.task : undefined;

  return (
    <div className="stack">
      <div className="crumbs">
        <a href={href("/leaderboard")}>Leaderboard</a> <span aria-hidden>/</span> Runs
      </div>
      <FixtureNote data={[runs.data, cfgs.data]} />

      <RxHead configId={configId} cfg={cfg} row={row} configs={cfgs.data ?? []} repo={repo} />

      <div className="m-toolbar rx-toolbar">
        <div className="seg" role="group" aria-label="Verdict">
          <button type="button" className={!f.verdict && !f.unused ? "active" : ""} onClick={() => setF({ verdict: undefined, unused: undefined })}>
            All <span className="count">{byV.length}</span>
          </button>
          <button type="button" className={f.verdict === "pass" ? "active" : ""} onClick={() => setF({ verdict: "pass", unused: undefined })}>
            ✓ Pass <span className="count">{nPass}</span>
          </button>
          <button type="button" className={f.verdict === "fail" && !f.unused ? "active" : ""} onClick={() => setF({ verdict: "fail", unused: undefined })}>
            ✕ Fail <span className="count">{nFail}</span>
          </button>
        </div>
        {!noMem && (
          <button
            type="button"
            className={`fchip fchip-unused${f.unused ? " active" : ""}`}
            title="Failed runs where memory did return the gold evidence: retrieved, but pi didn’t act on it"
            onClick={() => setF({ unused: f.unused ? undefined : "1", verdict: undefined })}
          >
            Retrieved but not used <span className="count">{nUnused}</span>
          </button>
        )}
        <div className="seg" role="group" aria-label="Horizon">
          <button type="button" className={!f.h ? "active" : ""} onClick={() => setF({ h: undefined })}>
            All horizons <span className="count">{byH.length}</span>
          </button>
          {horizons.map((h) => (
            <button key={h} type="button" className={f.h === h ? "active" : ""} onClick={() => setF({ h: String(h) })}>
              +{h}d <span className="count">{byH.filter((r) => r.horizon_days === h).length}</span>
            </button>
          ))}
        </div>
        {f.caseId && (
          <span className="fchip active" title={caseTask}>
            case: {caseTask ? `${caseTask.slice(0, 40)}…` : f.caseId}
            <button type="button" className="linkbtn" aria-label="Clear case filter" onClick={() => setF({ case: undefined })}>
              ✕
            </button>
          </span>
        )}
        <span className="rx-count muted small">
          {shown.length} of {all.length} runs · {repo ? <span className="mono">{repo}</span> : "all repos"}
          <span className="rx-hint"> (repo: header switcher)</span>
        </span>
      </div>

      {shown.length ? (
        <RunTable runs={shown} params={params} noMem={noMem} showRepo={!repo} />
      ) : (
        <div className="empty empty-card">
          <strong>No runs match these filters.</strong>
          <span>
            {all.length ? (
              <button type="button" className="linkbtn" onClick={() => setF({ verdict: undefined, unused: undefined, h: undefined, case: undefined })}>
                Clear filters
              </button>
            ) : (
              `No runs recorded for ${configId} yet.`
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function RxHead({
  configId,
  cfg,
  row,
  configs,
  repo,
}: {
  configId: string;
  cfg?: HarnessConfig;
  row?: LeaderboardRow;
  configs: HarnessConfig[];
  repo?: string;
}) {
  const tuned = isTuned(configId) || cfg?.tuned;
  const noMem = cfg?.memory === false || row?.evidence_recall == null;
  const k = row?.k ?? 3;
  const stats: { label: string; value: string; title?: string }[] = row
    ? [
        { label: "pass@1", value: pct(row.pass_at_1) },
        { label: `pass^${k}`, value: pct(row.pass_pow_3), title: `Share of (case, cutoff) units that passed all ${k} repeats` },
        { label: "evidence recall", value: noMem ? "-" : pct(row.evidence_recall), title: "Share of runs where memory returned the gold evidence" },
        { label: "$ / run", value: usd(row.cost_usd_per_run) },
      ]
    : [];
  return (
    <div className="panel rx-head">
      <div className="rx-head-main">
        <div className="rx-title">
          {tuned && (
            <span className="badge-tuned" title="Proposed by the self-tuning harness">
              ✦ tuned
            </span>
          )}
          <h1>{cfg?.label ?? row?.label ?? configId}</h1>
          <label className="rx-pick">
            <span className="sr-only">Config</span>
            <select className="mono" value={configId} onChange={(e) => (window.location.hash = runsHref(e.target.value))}>
              {!configs.some((c) => c._id === configId) && <option value={configId}>{configName(configId)}</option>}
              {configs.map((c) => (
                <option key={c._id} value={c._id}>
                  {configName(c._id)} · {c.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="cfg-meta">
          <span className="mono" title={configId}>
            {configId}
          </span>
          {configFlags(cfg).map((fl) => (
            <span key={fl} className={`flag${fl === "keeps superseded" ? " flag-warn" : ""}`}>
              {fl}
            </span>
          ))}
        </div>
        {tuned && cfg?.hypothesis && <div className="cfg-hypo rx-hypo">“{cfg.hypothesis}”</div>}
      </div>
      {stats.length > 0 && (
        <div className="rx-stats" title={`Leaderboard numbers for ${repo ?? "all repos"}`}>
          {stats.map((s) => (
            <div key={s.label} className="rx-stat" title={s.title}>
              <div className="rx-stat-v">{s.value}</div>
              <div className="rx-stat-l">{s.label}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RunTable({ runs, params, noMem, showRepo }: { runs: RunListItem[]; params: Record<string, string | undefined>; noMem: boolean; showRepo: boolean }) {
  return (
    <div className="panel panel-flush">
      <table className="rx">
        <thead>
          <tr>
            <th className="rx-task">Task</th>
            {showRepo && <th>Repo</th>}
            <th className="num" title="Days between the knowledge and the task">
              Horizon
            </th>
            <th className="num" title="Repeat index (same case, same cutoff)">
              Rep
            </th>
            <th>Verdict</th>
            <th title="Did pi call search_memory?">Memory</th>
            <th title="Did memory put the gold evidence in front of pi?">Gold</th>
            <th className="num" title="Memory items pi saw (briefing + search results)">
              Items
            </th>
            <th className="num">Cost</th>
            <th className="num">Time</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r, i) => {
            const to = runHref(r._id, params);
            // Repeats of the same case sit together: dim the task text after its first row.
            const sameCase = i > 0 && runs[i - 1].case_id === r.case_id;
            const unused = r.verdict === "fail" && r.hit_gold;
            return (
              <tr
                key={r._id}
                className={`rx-row rx-${r.verdict}${unused ? " rx-unused" : ""}${sameCase ? " rx-same" : " rx-first"}`}
                onClick={(e) => {
                  if (!(e.target as HTMLElement).closest("a")) window.location.hash = to;
                }}
              >
                <td className="rx-task">
                  <a href={to} title={r.task}>
                    {r.task || r.case_id}
                  </a>
                </td>
                {showRepo && (
                  <td className="mono rx-repo" title={r.repo_id}>
                    {repoShort(r.repo_id)}
                  </td>
                )}
                <td className="num mono">+{r.horizon_days}d</td>
                <td className="num mono">{isLive(r) ? <span className="tag tag-live">live</span> : `r${r.repeat}`}</td>
                <td>
                  <VerdictChip v={r.verdict} />
                </td>
                <td>
                  {noMem ? (
                    <span className="muted">-</span>
                  ) : r.used_memory_tool ? (
                    <span className="rx-mem-yes" title="pi called search_memory">
                      <span className="rx-mem-ico" aria-hidden>
                        ⌕
                      </span>{" "}
                      searched
                    </span>
                  ) : r.n_context ? (
                    <span className="muted" title="pi didn’t search; it only saw the briefing">
                      briefing
                    </span>
                  ) : (
                    <span className="muted">none</span>
                  )}
                </td>
                <td>
                  {noMem ? (
                    <span className="muted">-</span>
                  ) : r.hit_gold ? (
                    <span className={`rx-gold-yes${unused ? " rx-gold-unused" : ""}`} title={unused ? "Gold evidence retrieved, but the run failed" : "Gold evidence retrieved"}>
                      ✓{unused && " not used"}
                    </span>
                  ) : (
                    <span className="rx-gold-no" title="Gold evidence not retrieved">
                      ✗
                    </span>
                  )}
                </td>
                <td className="num mono">{noMem ? "-" : r.n_context}</td>
                <td className="num mono">{usd(r.cost_usd)}</td>
                <td className="num mono">{fmtDuration(r.duration_s)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ConfigPicker({ configs }: { configs?: HarnessConfig[] }) {
  if (!configs) return <Loading what="configs" />;
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Inspect runs</h1>
        <p className="lede">Pick a memory config to browse its eval runs and open any run’s full trace.</p>
      </div>
      <div className="panel">
        <ul className="rx-pick-list">
          {configs.map((c) => (
            <li key={c._id}>
              <a href={runsHref(c._id)}>
                <strong>{c.label}</strong> <span className="mono muted">{c._id}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
