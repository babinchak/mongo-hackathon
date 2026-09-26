import { useState } from "react";
import { getCases, getConfigs } from "../api";
import { ErrorBox, FixtureNote, Loading, ScenarioTag, StatusTag } from "../components/ui";
import { caseHref, CONFIG_SHORT, href, fmtShortDate, pct, useAsync } from "../lib";
import type { CaseStatus } from "../types";

const FILTERS: { key: CaseStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "approved", label: "Approved" },
  { key: "validated", label: "Validated" },
  { key: "rejected", label: "Rejected" },
  { key: "filtered_out", label: "Filtered out" },
];

export default function CasesList({ repo }: { repo: string }) {
  const [filter, setFilter] = useState<CaseStatus | "all">("all");
  const res = useAsync(() => getCases(repo), [repo]);
  const cfgs = useAsync(() => getConfigs(), []);
  if (res.error) return <ErrorBox error={res.error} retry={res.reload} />;
  if (!res.data) return <Loading what="cases" />;

  const { cases, summary } = res.data;
  const shown = cases.filter((c) => filter === "all" || c.status === filter);
  const cfgIds = (cfgs.data ?? []).map((c) => c._id).filter((id) => id !== "oracle");
  const counts = Object.fromEntries(
    FILTERS.map((f) => [f.key, f.key === "all" ? cases.length : cases.filter((c) => c.status === f.key).length]),
  );

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Eval cases</h1>
          <p className="lede">
            Each case is a future task mined from a real correction. The agent is dropped at a cutoff after the moment and can’t see
            anything later.
          </p>
        </div>
      </div>
      <FixtureNote data={[res.data, cfgs.data]} />
      {!cases.length ? (
        <div className="empty empty-card">
          <strong>No cases yet for {repo}.</strong>
          <span>
            Generation runs after mining. Meanwhile, the mined moments are browsable in <a href={href("/moments")}>Moments</a>.
          </span>
        </div>
      ) : (
        <>
          <div className="tabs">
            {FILTERS.map((f) => (
              <button key={f.key} type="button" className={filter === f.key ? "active" : ""} onClick={() => setFilter(f.key)}>
                {f.label} <span className="count">{counts[f.key]}</span>
              </button>
            ))}
          </div>
          <div className="panel panel-flush">
            <table className="cases">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Scenario</th>
                  <th>Status</th>
                  {cfgIds.map((id) => (
                    <th key={id} className="num cfg-col" title={id}>
                      <span className="mono cfg-short">{CONFIG_SHORT[id] ?? id}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c._id} className="clickable" onClick={() => (window.location.hash = caseHref(c._id).slice(1))}>
                    <td className="task-cell">
                      <a href={caseHref(c._id)} onClick={(e) => e.stopPropagation()}>
                        {c.task}
                      </a>
                      <div className="task-meta">
                        <span className="mono">{c._id}</span>
                        <span>
                          moment {fmtShortDate(c.cutoffs[0]?.cutoff ? addDays(c.cutoffs[0].cutoff, -c.cutoffs[0].horizon_days) : "")}
                        </span>
                        {c.repeated_in_real_life && <span className="flag flag-accent">repeated in real life</span>}
                        {c.chat_only === false && <span className="flag">repo answers it</span>}
                      </div>
                    </td>
                    <td>
                      <ScenarioTag s={c.scenario} />
                    </td>
                    <td>
                      <StatusTag s={c.status} />
                    </td>
                    {cfgIds.map((id) => {
                      const s = summary[c._id]?.[id];
                      return (
                        <td key={id} className="num">
                          {s && s.pass != null ? (
                            <span
                              className="mini-heat"
                              style={{ ["--heat" as string]: s.pass }}
                              title={`${id}: ${pct(s.pass)}${s.n ? ` of ${s.n} runs` : ""}`}
                            >
                              {Math.round(s.pass * 100)}
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {!shown.length && <div className="empty">No cases with this status.</div>}
          </div>
          <p className="muted small">
            Cells: sweep pass rate (%) for that config on the case, both horizons. Hover a column header for the full config id.
          </p>
        </>
      )}
    </div>
  );
}

function addDays(s: string, d: number) {
  return new Date(new Date(s).getTime() + d * 86400000).toISOString();
}
