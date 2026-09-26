import { useEffect, useMemo, useRef, useState } from "react";
import { getCase, getConfigs, postRun, STATIC } from "../api";
import {
  ErrorBox,
  FixtureNote,
  KindTag,
  Loading,
  Panel,
  PlanText,
  RichText,
  ScenarioTag,
  SnapshotChatNote,
  StatusTag,
  VerdictChip,
  VerdictDot,
} from "../components/ui";
import { fmtDate, fmtDuration, fmtShortDate, fmtTime, href, isFar, isLive, momentHref, pct, shortSha, toolSummary, usd, useAsync } from "../lib";
import type { CaseDetail, CaseDoc, HarnessConfig, MomentDoc, RunDoc, TurnDoc } from "../types";

export default function CaseInspector({ id }: { id: string }) {
  const res = useAsync(() => getCase(id), [id]);
  const cfgs = useAsync(() => getConfigs(), []);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [liveIds, setLiveIds] = useState<Set<string>>(new Set());

  if (res.error) return <ErrorBox error={res.error} retry={res.reload} />;
  if (!res.data) return <Loading what="case" />;
  const d = res.data;
  const c = d.case;
  const evidence = new Set([...(c.gold_evidence ?? []), ...(d.moment?.evidence ?? []), ...(d.source_turns ?? []).filter((t) => t.evidence).map((t) => t._id)]);

  const toggle = (rid: string, force?: boolean) =>
    setOpen((s) => {
      const n = new Set(s);
      if (force ?? !n.has(rid)) n.add(rid);
      else n.delete(rid);
      return n;
    });
  const focusRun = (rid: string) => {
    toggle(rid, true);
    requestAnimationFrame(() => document.getElementById(`run-${rid}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };
  const addRun = (run: RunDoc) => {
    setLiveIds((s) => new Set(s).add(run._id));
    res.setData((prev) => (prev ? { ...prev, runs: [...prev.runs, run] } : prev));
  };

  return (
    <div className="stack">
      <div className="crumbs">
        <a href={href("/cases")}>Cases</a> <span aria-hidden>/</span> <span className="mono">{c._id}</span>
      </div>
      <FixtureNote data={[res.data, cfgs.data]} />
      <div className="page-head">
        <div>
          <div className="head-tags">
            <ScenarioTag s={c.scenario} />
            <StatusTag s={c.status} />
            {c.repeated_in_real_life && <span className="flag flag-accent">repeated in real life</span>}
            {c.chat_only === true && <span className="flag">chat-only</span>}
            {c.chat_only === false && <span className="flag flag-warn">repo answers it</span>}
          </div>
          <h1 className="task-title">{c.task}</h1>
        </div>
      </div>

      <div className="grid-inspector">
        <div className="stack">
          {d.moment ? <MomentPanel m={d.moment} related={d.related_moments ?? []} /> : <Panel title="Moment"><span className="muted">moment {c.moment_id} not found</span></Panel>}
          <Conversation turns={d.source_turns ?? []} evidence={evidence} sourceId={d.moment?.source_turn_id ?? ""} />
        </div>
        <div className="stack">
          <RunNow c={c} configs={cfgs.data ?? []} onResult={addRun} runs={d.runs} open={open} toggle={toggle} />
          <CasePanel c={c} />
        </div>
      </div>
      <Runs d={d} configs={cfgs.data ?? []} open={open} toggle={toggle} focusRun={focusRun} liveIds={liveIds} evidence={evidence} />
    </div>
  );
}

// ------------------------------------------------------------------ moment + conversation
function MomentPanel({ m, related }: { m: MomentDoc; related: MomentDoc[] }) {
  const olders = related.filter((r) => m.supersedes.includes(r._id));
  const newers = related.filter((r) => m.superseded_by.includes(r._id));
  const repeats = related.filter((r) => m.repeated_by.includes(r._id) || m.repeats.includes(r._id));
  return (
    <Panel
      title="Moment"
      aside={
        <a className="mono small" title="Open in the Moments browser" href={momentHref(m._id, m.repo_id)}>
          {m._id} →
        </a>
      }
    >
      <div className="moment">
        <div className="moment-meta">
          <KindTag k={m.moment_kind} />
          <span className="tag">{m.topic}</span>
          <span>{fmtDate(m.ts)}</span>
          <span className="confidence" title={`confidence ${m.confidence}/5`}>
            {"●".repeat(m.confidence)}
            <span className="muted">{"●".repeat(Math.max(0, 5 - m.confidence))}</span>
          </span>
          {!isFar(m.superseded_at) && <span className="flag flag-warn">superseded {fmtShortDate(m.superseded_at)}</span>}
        </div>
        <blockquote className="moment-text">
          <RichText text={m.text} />
        </blockquote>
        {olders.map((o) => (
          <div key={o._id} className="related related-old">
            <span className="related-label">Supersedes · {fmtShortDate(o.ts)}</span>
            <s>{o.text}</s>
          </div>
        ))}
        {newers.map((o) => (
          <div key={o._id} className="related">
            <span className="related-label">Superseded by · {fmtShortDate(o.ts)}</span>
            {o.text}
          </div>
        ))}
        {repeats.map((o) => (
          <div key={o._id} className="related related-repeat">
            <span className="related-label">Said again · {fmtShortDate(o.ts)}</span>
            {o.text.replace(/^\(repeat\)\s*/, "")}
          </div>
        ))}
      </div>
    </Panel>
  );
}

function Conversation({ turns, evidence, sourceId }: { turns: TurnDoc[]; evidence: Set<string>; sourceId: string }) {
  if (STATIC)
    return (
      <Panel title="Source conversation">
        <SnapshotChatNote />
      </Panel>
    );
  if (!turns.length) return null;
  return (
    <Panel
      title="Source conversation"
      aside={
        <span className="muted">
          session <span className="mono">{turns[0].session_id}</span> · {fmtDate(turns[0].ts)}
        </span>
      }
    >
      <ol className="convo">
        {turns.map((t) => {
          const ev = evidence.has(t._id);
          return (
            <li key={t._id} className={`turn turn-${t.role}${ev ? " turn-evidence" : ""}${t.noise ? " turn-noise" : ""}`}>
              <div className="turn-head">
                <span className="turn-role">{t.role}</span>
                <span className="muted mono">
                  #{t.seq} · {fmtTime(t.ts)}
                </span>
                {t.pushback && <span className="tag tag-pushback">{t.pushback.replace("_", " ")}</span>}
                {t._id === sourceId && <span className="tag tag-source">source</span>}
                {ev && <span className="tag tag-evidence">evidence</span>}
                <span className="turn-id mono muted">{t._id}</span>
              </div>
              <div className="turn-text">
                <RichText text={t.text} />
              </div>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

// ------------------------------------------------------------------ case spec
function CasePanel({ c }: { c: CaseDoc }) {
  return (
    <Panel title="Case">
      <dl className="spec">
        <dt>Expected</dt>
        <dd>
          <RichText text={c.expected} />
        </dd>
        <dt>Fail signals</dt>
        <dd className="chips">
          {c.fail_signals.map((f) => (
            <code key={f} className="chip-fail">
              {f}
            </code>
          ))}
        </dd>
        {c.keywords.length > 0 && (
          <>
            <dt>Keywords</dt>
            <dd className="chips">
              {c.keywords.map((k) => (
                <span key={k} className="chip">
                  {k}
                </span>
              ))}
            </dd>
          </>
        )}
        <dt>Cutoffs</dt>
        <dd>
          <table className="mini">
            <thead>
              <tr>
                <th>Horizon</th>
                <th>Cutoff (agent sees nothing after)</th>
                <th>Commit</th>
              </tr>
            </thead>
            <tbody>
              {c.cutoffs.map((k) => (
                <tr key={k.horizon_days}>
                  <td className="mono">{k.horizon_days}d</td>
                  <td>
                    {fmtDate(k.cutoff)} <span className="muted mono">{fmtTime(k.cutoff)}Z</span>
                  </td>
                  <td className="mono" title={k.commit ?? undefined}>
                    {shortSha(k.commit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </dd>
        <dt>Validation</dt>
        <dd>
          {c.validation ? (
            <div className="validation">
              {Object.entries(c.validation).map(([cfg, vs]) => (
                <div key={cfg} className="validation-row">
                  <span className="mono">{cfg}</span>
                  <span className="validation-dots">
                    {vs.map((v, i) => (
                      <VerdictChip key={i} v={v} />
                    ))}
                  </span>
                  <span className="muted small">
                    {cfg === "repo_only" ? "should fail: repo alone isn’t enough" : cfg === "oracle" ? "should pass: evidence pasted in" : ""}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <span className="muted">not validated</span>
          )}
        </dd>
        <dt>Gold evidence</dt>
        <dd className="chips">
          {c.gold_evidence.map((g) => (
            <span key={g} className="chip mono chip-gold">
              {g}
            </span>
          ))}
        </dd>
        {c.review && (
          <>
            <dt>Review</dt>
            <dd>
              <span className={`tag ${c.review.verdict === "approve" ? "status-approved" : "status-rejected"}`}>{c.review.verdict}</span>{" "}
              {c.review.reason}
            </dd>
          </>
        )}
      </dl>
    </Panel>
  );
}

// ------------------------------------------------------------------ run now
interface Pending {
  key: string;
  config_id: string;
  horizon_days: number;
  started: number;
  error?: string;
  runId?: string;
  finished?: number;
}

function RunNow({
  c,
  configs,
  onResult,
  runs,
  open,
  toggle,
}: {
  c: CaseDoc;
  configs: HarnessConfig[];
  onResult: (r: RunDoc) => void;
  runs: RunDoc[];
  open: Set<string>;
  toggle: (id: string, force?: boolean) => void;
}) {
  const usable = configs.filter((x) => x._id !== "oracle");
  const [cfg, setCfg] = useState<string>("");
  const [horizon, setHorizon] = useState<number>(c.cutoffs[0]?.horizon_days ?? 7);
  const [pending, setPending] = useState<Pending[]>([]);
  const [now, setNow] = useState(Date.now());
  const running = pending.some((p) => !p.finished);

  useEffect(() => {
    if (!cfg && usable.length) setCfg(usable.find((x) => x._id === "hybrid_all_brief")?._id ?? usable[0]._id);
  }, [usable, cfg]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [running]);

  const start = () => {
    if (!cfg) return;
    const p: Pending = { key: Math.random().toString(36).slice(2), config_id: cfg, horizon_days: horizon, started: Date.now() };
    setPending((ps) => [p, ...ps]);
    postRun(c._id, cfg, horizon).then(
      (run) => {
        onResult(run);
        toggle(run._id, true);
        setPending((ps) => ps.map((x) => (x.key === p.key ? { ...x, runId: run._id, finished: Date.now() } : x)));
      },
      (e) => setPending((ps) => ps.map((x) => (x.key === p.key ? { ...x, error: String(e?.message ?? e), finished: Date.now() } : x))),
    );
  };
  const cutoff = c.cutoffs.find((k) => k.horizon_days === horizon);
  const cfgDoc = usable.find((x) => x._id === cfg);

  return (
    <Panel
      className="runnow"
      title="Run now"
      aside={<span className="muted">pi, unchanged + Atlas memory extension{STATIC ? "" : " · live"}</span>}
    >
      <div className="runnow-form">
        <label>
          <span>Config</span>
          <select value={cfg} onChange={(e) => setCfg(e.target.value)}>
            {usable.map((x) => (
              <option key={x._id} value={x._id}>
                {x.label} ({x._id})
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Horizon</span>
          <select value={horizon} onChange={(e) => setHorizon(+e.target.value)}>
            {c.cutoffs.map((k) => (
              <option key={k.horizon_days} value={k.horizon_days}>
                {k.horizon_days} days (cutoff {fmtShortDate(k.cutoff)})
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-primary btn-run" onClick={start} disabled={!cfg || STATIC}>
          ▶ Run now
        </button>
        <div className="runnow-note muted">
          {STATIC
            ? "Live runs need the local harness (pi + Atlas). This hosted page is a read-only snapshot of the results."
            : cfgDoc?.memory === false
            ? "No memory extension: pi sees only the repo snapshot."
            : `Every memory query is filtered to ts < ${cutoff ? fmtDate(cutoff.cutoff) : "cutoff"} inside Atlas.`}
        </div>
      </div>
      {pending.length > 0 && (
        <div className="runnow-list">
          {pending.map((p) => {
            const run = p.runId ? runs.find((r) => r._id === p.runId) : undefined;
            const elapsed = ((p.finished ?? now) - p.started) / 1000;
            if (run)
              return (
                <div key={p.key} className="runnow-result">
                  <RunRow run={run} c={c} open={open.has(run._id)} toggle={() => toggle(run._id)} live showConfig />
                </div>
              );
            return (
              <div key={p.key} className={`runnow-pending${p.error ? " runnow-error" : ""}`}>
                {p.error ? (
                  <VerdictChip v="error" />
                ) : (
                  <span className="spinner" aria-hidden />
                )}
                <span className="mono">{p.config_id}</span>
                <span>
                  {p.horizon_days}d horizon
                </span>
                <span className="elapsed mono">{elapsed.toFixed(1)}s</span>
                <span className="muted">{p.error ? p.error : "pi is planning against the snapshot at the cutoff…"}</span>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ recorded runs
function Runs({
  d,
  configs,
  open,
  toggle,
  focusRun,
  liveIds,
  evidence,
}: {
  d: CaseDetail;
  configs: HarnessConfig[];
  open: Set<string>;
  toggle: (id: string) => void;
  focusRun: (id: string) => void;
  liveIds: Set<string>;
  evidence: Set<string>;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Validation runs (phase "validation") are shown in their own groups, not in the sweep matrix.
  const evalRuns = useMemo(() => d.runs.filter((r) => r.phase !== "validation"), [d.runs]);
  const valRuns = useMemo(() => d.runs.filter((r) => r.phase === "validation"), [d.runs]);
  const order = useMemo(() => {
    const ids = configs.map((c) => c._id);
    for (const r of evalRuns) if (!ids.includes(r.config_id)) ids.push(r.config_id);
    return ids.filter((id) => evalRuns.some((r) => r.config_id === id));
  }, [configs, evalRuns]);
  const horizons = [...new Set(evalRuns.map((r) => r.horizon_days))].sort((a, b) => a - b);
  const label = (id: string) => configs.find((c) => c._id === id)?.label ?? id;
  const sorted = (rs: RunDoc[]) =>
    [...rs].sort(
      (a, b) =>
        a.horizon_days - b.horizon_days || Number(isLive(a)) - Number(isLive(b)) || a.repeat - b.repeat || String(a.created_at).localeCompare(String(b.created_at)),
    );
  const ref = useRef<HTMLDivElement>(null);
  const groups: { key: string; title: string; id: string; runs: RunDoc[] }[] = [
    ...order.map((id) => ({ key: id, title: label(id), id, runs: sorted(evalRuns.filter((r) => r.config_id === id)) })),
    ...[...new Set(valRuns.map((r) => r.config_id))].map((id) => ({
      key: `validation:${id}`,
      title: `Validation · ${label(id)}`,
      id,
      runs: sorted(valRuns.filter((r) => r.config_id === id)),
    })),
  ];

  if (!d.runs.length) return <Panel title="Runs">{<div className="empty">No runs recorded for this case yet.</div>}</Panel>;

  return (
    <div ref={ref} className="stack">
      <Panel title="Runs by config" aside={<span className="muted">{evalRuns.length} runs · click a square to open it</span>}>
        <table className="matrix">
          <thead>
            <tr>
              <th>Config</th>
              {horizons.map((h) => (
                <th key={h}>{h}-day horizon</th>
              ))}
              <th className="num">pass</th>
              <th className="num">gold hit</th>
              <th className="num">used memory</th>
              <th className="num">avg $</th>
            </tr>
          </thead>
          <tbody>
            {order.map((id) => {
              const rs = evalRuns.filter((r) => r.config_id === id);
              const pass = rs.filter((r) => r.verdict === "pass").length;
              const cfg = configs.find((c) => c._id === id);
              return (
                <tr key={id}>
                  <th>
                    <div className="cfg-label">{label(id)}</div>
                    <div className="mono muted small">{id}</div>
                  </th>
                  {horizons.map((h) => (
                    <td key={h}>
                      <div className="dots">
                        {sorted(rs.filter((r) => r.horizon_days === h)).map((r) => (
                          <VerdictDot
                            key={r._id}
                            v={r.verdict}
                            active={open.has(r._id)}
                            title={`${id} · ${h}d · ${isLive(r) || liveIds.has(r._id) ? "live run" : `repeat ${r.repeat}`}: ${r.verdict}`}
                            onClick={() => focusRun(r._id)}
                          />
                        ))}
                      </div>
                    </td>
                  ))}
                  <td className="num strong">
                    {pass}/{rs.length}
                  </td>
                  <td className="num">{cfg?.memory === false ? "-" : pct(rs.filter((r) => r.hit_gold).length / rs.length)}</td>
                  <td className="num">{cfg?.memory === false ? "-" : pct(rs.filter((r) => r.used_memory_tool).length / rs.length)}</td>
                  <td className="num">{usd(rs.reduce((a, r) => a + r.cost_usd, 0) / rs.length)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      {groups.map(({ key, title, id, runs: rs }) => {
        const isCollapsed = collapsed.has(key);
        return (
          <section key={key} className="panel run-group">
            <header
              className="panel-head clickable"
              onClick={() =>
                setCollapsed((s) => {
                  const n = new Set(s);
                  if (n.has(key)) n.delete(key);
                  else n.add(key);
                  return n;
                })
              }
            >
              <h2>
                <span className="caret" aria-hidden>
                  {isCollapsed ? "▸" : "▾"}
                </span>{" "}
                {title} <span className="mono muted small">{id}</span>
              </h2>
              <div className="panel-aside">
                {rs.filter((r) => r.verdict === "pass").length}/{rs.length} pass
              </div>
            </header>
            {!isCollapsed && (
              <div className="run-list">
                {rs.map((r) => (
                  <RunRow key={r._id} run={r} c={d.case} open={open.has(r._id)} toggle={() => toggle(r._id)} live={liveIds.has(r._id) || isLive(r)} evidence={evidence} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function RunRow({
  run,
  c,
  open,
  toggle,
  live,
  showConfig,
  evidence,
}: {
  run: RunDoc;
  c: CaseDoc;
  open: boolean;
  toggle: () => void;
  live?: boolean;
  showConfig?: boolean;
  evidence?: Set<string>;
}) {
  const tools = run.tool_calls ?? [];
  const ctx = run.context_ids ?? [];
  const nSearch = tools.filter((t) => t.tool === "search_memory").length;
  const gold = evidence ?? new Set(c.gold_evidence ?? []);
  return (
    <div id={`run-${run._id}`} className={`run run-${run.verdict}${open ? " run-open" : ""}`}>
      <button type="button" className="run-summary" onClick={toggle} aria-expanded={open}>
        <VerdictChip v={run.verdict} />
        {showConfig && <span className="mono strong">{run.config_id}</span>}
        <span className="mono run-hr">
          {run.horizon_days}d{run.repeat >= 0 ? ` · r${run.repeat}` : ""}
        </span>
        {live && <span className="tag tag-live">live</span>}
        <span className={`run-mem ${nSearch ? "run-mem-yes" : ""}`}>{nSearch ? `search_memory ×${nSearch}` : ctx.length ? "briefing only" : "no memory call"}</span>
        <span className={`run-gold ${run.hit_gold ? "run-gold-yes" : ""}`}>{run.hit_gold ? "gold hit" : "gold missed"}</span>
        <span className="run-stat mono">{tools.length} tools</span>
        <span className="run-stat mono">{usd(run.cost_usd)}</span>
        <span className="run-stat mono">{fmtDuration(run.duration_s)}</span>
        <span className="run-reason">
          <RichText text={run.reason ?? ""} />
        </span>
        <span className="caret" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="run-detail">
          <div className="run-cols">
            <div>
              <h3>Tool calls ({tools.length})</h3>
              <ol className="tools">
                {tools.map((t, i) => (
                  <li key={i} className={t.tool === "search_memory" ? "tool-mem" : ""}>
                    <span className="tool-name mono">{t.tool}</span>
                    <span className="tool-args mono">{toolSummary(t)}</span>
                  </li>
                ))}
              </ol>
            </div>
            <div>
              <h3>Judge</h3>
              <p className="judge">
                <VerdictChip v={run.verdict} />{" "}
                <span>
                  <RichText text={run.reason ?? ""} />
                </span>
              </p>
              <h3>Memory context ({ctx.length})</h3>
              {ctx.length ? (
                <div className="chips">
                  {ctx.map((cid) => (
                    <span key={cid} className={`chip mono${gold.has(cid) ? " chip-gold" : ""}`} title={gold.has(cid) ? "gold evidence" : undefined}>
                      {gold.has(cid) && "★ "}
                      {cid}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="muted">none</p>
              )}
              <div className="run-facts muted small mono">
                {run.model ?? "model ?"} · {run.turns ?? "?"} turns · cutoff {fmtShortDate(run.cutoff)} · {shortSha(run.commit)} · {run._id.slice(0, 8)}
              </div>
            </div>
          </div>
          <h3>Plan (final message)</h3>
          <PlanText text={run.response} failSignals={c.fail_signals} />
        </div>
      )}
    </div>
  );
}
