import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getRun, getRuns, STATIC } from "../api";
import { ErrorBox, FixtureNote, KindTag, Loading, Panel, PlanText, RichText, ScenarioTag, VerdictChip } from "../components/ui";
import {
  applyRunFilter,
  caseHref,
  configName,
  failTerms,
  fmtDate,
  fmtDuration,
  fmtShortDate,
  href,
  isLive,
  isTuned,
  parseDate,
  readRunFilter,
  runFilterParams,
  runHref,
  runsHref,
  shortSha,
  sortRuns,
  toolSummary,
  useAsync,
  useHashQuery,
  usd,
} from "../lib";
import type { MemoryItem, RunListItem, RunTrace, ToolCall } from "../types";

/** #/run/<id>: everything about one eval run, top to bottom. repo undefined = all repos (only affects prev / next). */
export default function RunTraceView({ id, repo }: { id: string; repo?: string }) {
  const t = useAsync(() => getRun(id), [id]);
  const q = useHashQuery();
  const configId = t.data?.run.config_id;
  const list = useAsync(() => (configId ? getRuns(configId) : Promise.resolve(undefined)), [configId]);
  const f = readRunFilter(q, repo);
  const params = runFilterParams(f);

  // Prev / next walk the list the viewer came from; fall back to the whole config if this run isn't in it.
  const nav = useMemo(() => {
    const all = list.data ?? [];
    const filtered = sortRuns(applyRunFilter(all, f));
    const seq = filtered.some((r) => r._id === id) ? filtered : sortRuns(all);
    const i = seq.findIndex((r) => r._id === id);
    return { seq, i, filtered: seq === filtered };
  }, [list.data, id, f.repo, f.caseId, f.verdict, f.unused, f.h]); // eslint-disable-line react-hooks/exhaustive-deps
  const prev = nav.i > 0 ? nav.seq[nav.i - 1] : undefined;
  const next = nav.i >= 0 && nav.i < nav.seq.length - 1 ? nav.seq[nav.i + 1] : undefined;
  const linkParams = nav.filtered ? params : {};

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
      if (e.key === "ArrowLeft" && prev) window.location.hash = runHref(prev._id, linkParams);
      if (e.key === "ArrowRight" && next) window.location.hash = runHref(next._id, linkParams);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  if (t.error) return <ErrorBox error={t.error} retry={t.reload} />;
  if (!t.data) return <Loading what="run trace" />;
  const d = t.data;
  const run = d.run;
  const listRow = list.data?.find((r) => r._id === id);
  const label = d.config?.label ?? configName(run.config_id);

  const navBar = (
    <RunNav prev={prev} next={next} pos={nav.i} total={nav.seq.length} params={linkParams} filtered={nav.filtered && Object.values(params).some(Boolean)} />
  );

  return (
    <div className="stack trace">
      <div className="trace-top">
        <div className="crumbs">
          <a href={href("/leaderboard")}>Leaderboard</a> <span aria-hidden>/</span>{" "}
          <a href={runsHref(run.config_id, params)}>Runs · {configName(run.config_id)}</a> <span aria-hidden>/</span>{" "}
          <span className="mono">run {run._id.slice(0, 8)}</span>
        </div>
        {navBar}
      </div>
      <FixtureNote data={[d]} />

      <TraceHead d={d} label={label} listRow={listRow} />

      <Panel title="Task: the prompt pi got" className="trace-task">
        <p className="trace-task-text">
          <RichText text={d.case.task || listRow?.task || ""} />
        </p>
        <details className="grader">
          <summary>
            <span className="grader-tag">grader only</span> Expected behavior and fail signals <span className="muted">(pi never saw these)</span>
          </summary>
          <dl className="spec grader-body">
            <dt>Expected</dt>
            <dd>
              <RichText text={d.case.expected} />
            </dd>
            <dt>Fail signals</dt>
            <dd>
              <ul className="grader-fails">
                {d.case.fail_signals.map((s) => (
                  <li key={s}>
                    <RichText text={s} />
                  </li>
                ))}
              </ul>
            </dd>
          </dl>
        </details>
      </Panel>

      <MemoryPanel d={d} />
      <ToolTimeline calls={run.tool_calls ?? []} />

      <Panel
        title="pi’s final plan"
        aside={failTerms(d.case.fail_signals).length ? <span className="muted">terms from the fail signals are highlighted</span> : undefined}
      >
        <PlanText text={run.response ?? ""} failSignals={failTerms(d.case.fail_signals)} />
      </Panel>

      <section className={`panel judge-panel judge-${run.verdict}`}>
        <div className="judge-label">Judge verdict</div>
        <div className="judge-row">
          <VerdictChip v={run.verdict} big />
          <p className="judge-reason">
            <RichText text={run.reason ?? ""} />
          </p>
        </div>
      </section>

      <div className="trace-foot">
        <span className="mono muted small">
          run {run._id} · created {run.created_at ? fmtDate(run.created_at) : "-"}
        </span>
        {navBar}
      </div>
    </div>
  );
}

function RunNav({
  prev,
  next,
  pos,
  total,
  params,
  filtered,
}: {
  prev?: RunListItem;
  next?: RunListItem;
  pos: number;
  total: number;
  params: Record<string, string | undefined>;
  filtered: boolean;
}) {
  if (pos < 0) return null;
  return (
    <div className="run-nav" title="Arrow keys ← → also step through the list">
      {prev ? (
        <a className="btn btn-small" href={runHref(prev._id, params)}>
          ← prev
        </a>
      ) : (
        <span className="btn btn-small" aria-disabled>
          ← prev
        </span>
      )}
      <span className="muted small mono">
        {pos + 1} / {total}
        {filtered ? " filtered" : ""}
      </span>
      {next ? (
        <a className="btn btn-small" href={runHref(next._id, params)}>
          next →
        </a>
      ) : (
        <span className="btn btn-small" aria-disabled>
          next →
        </span>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ header
function TraceHead({ d, label, listRow }: { d: RunTrace; label: string; listRow?: RunListItem }) {
  const run = d.run;
  const tuned = isTuned(run.config_id) || d.config?.tuned;
  const repo = d.case.repo_id || listRow?.repo_id || "";
  const facts: { k: string; v: ReactNode; title?: string }[] = [
    { k: "Repo", v: <span className="mono">{repo}</span> },
    {
      k: "Case",
      v: (
        <a href={caseHref(d.case._id)} title={d.case._id}>
          open case →
        </a>
      ),
    },
    {
      k: "Horizon",
      v: (
        <>
          +{run.horizon_days}d <span className="muted">· cutoff {fmtDate(run.cutoff)}</span>
        </>
      ),
      title: "pi and memory see nothing after the cutoff; the task is set this many days after the knowledge",
    },
    { k: "Repeat", v: isLive(run) ? <span className="tag tag-live">live</span> : <span className="mono">r{run.repeat}</span> },
    { k: "Cost", v: <span className="mono">{usd(run.cost_usd)}</span> },
    { k: "Duration", v: <span className="mono">{fmtDuration(run.duration_s)}</span> },
    { k: "Turns", v: <span className="mono">{run.turns ?? "-"}</span> },
    { k: "Model", v: <span className="mono">{run.model ?? "-"}</span> },
    { k: "Commit", v: <span className="mono">{shortSha(run.commit)}</span>, title: run.commit ?? undefined },
  ];
  return (
    <section className={`panel trace-head trace-head-${run.verdict}`}>
      <div className="trace-title">
        <VerdictChip v={run.verdict} big />
        <h1>
          {tuned && (
            <span className="badge-tuned" title="Proposed by the self-tuning harness">
              ✦ tuned
            </span>
          )}{" "}
          {label}
        </h1>
        <span className="mono muted">{run.config_id}</span>
        {d.case.scenario && <ScenarioTag s={d.case.scenario} />}
      </div>
      <dl className="trace-facts">
        {facts.map((x) => (
          <div key={x.k} title={x.title}>
            <dt>{x.k}</dt>
            <dd>{x.v}</dd>
          </div>
        ))}
      </dl>
      <div className="trace-judge">
        <span className="trace-judge-k">Judge</span>
        <RichText text={run.reason ?? ""} />
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ memory
function MemoryPanel({ d }: { d: RunTrace }) {
  const mem = d.memory ?? [];
  const noMem = d.config?.memory === false;
  const nGold = mem.filter((m) => m.is_gold).length;
  const searches = (d.run.tool_calls ?? []).filter((c) => c.tool === "search_memory").length;
  const how = [d.config?.briefing ? `briefing${d.config.briefing_k ? ` (top ${d.config.briefing_k})` : ""}` : "", searches ? `${searches} search_memory call${searches === 1 ? "" : "s"}` : ""]
    .filter(Boolean)
    .join(" + ");
  return (
    <Panel
      title="What memory put in front of pi"
      className="trace-mem"
      aside={
        noMem ? undefined : (
          <span className="mem-summary">
            <strong>{mem.length}</strong> item{mem.length === 1 ? "" : "s"} ·{" "}
            <span className={nGold ? "mem-summary-gold" : "mem-summary-miss"}>gold retrieved {nGold ? "✓" : "✗"}</span>
            {how && <span className="muted"> · {how}, pooled</span>}
          </span>
        )
      }
    >
      {noMem ? (
        <p className="muted">No memory extension: pi saw only the repo snapshot at the cutoff.</p>
      ) : !mem.length ? (
        <p className="muted">Memory returned nothing for this run.</p>
      ) : (
        <ol className="mem-list">
          {mem.map((m, i) => (
            <MemItem key={`${m.id}-${i}`} m={m} n={i + 1} cutoff={d.run.cutoff} />
          ))}
        </ol>
      )}
    </Panel>
  );
}

function MemItem({ m, n, cutoff }: { m: MemoryItem; n: number; cutoff: string }) {
  const long = m.text.length > 420;
  const [open, setOpen] = useState(false);
  const ago = Math.floor((parseDate(cutoff).getTime() - parseDate(m.ts).getTime()) / 86_400_000);
  return (
    <li className={`mem mem-${m.kind}${m.is_gold ? " mem-gold" : ""}`}>
      <div className="mem-head">
        <span className="mem-n mono">{n}</span>
        {m.is_gold && <span className="tag tag-gold">★ gold evidence</span>}
        {m.kind === "moment" ? <KindTag k={m.moment_kind ?? "none"} /> : <span className="turn-role">{m.role ?? "chat"} turn</span>}
        {m.topic && <span className="mem-topic">{m.topic}</span>}
        <span className="mem-date" title={m.ts}>
          {fmtShortDate(m.ts)}
          {Number.isFinite(ago) && ago >= 0 && <span className="muted"> · {ago === 0 ? "same day as cutoff" : `${ago}d before cutoff`}</span>}
        </span>
        <span className="mem-id mono muted">{m.id}</span>
      </div>
      {m.redacted || (m.kind === "turn" && STATIC && !m.text) ? (
        <p className="mem-redacted muted small">Raw chat text not published in the hosted snapshot.</p>
      ) : (
        <div className={`mem-text${long && !open ? " mem-clamp" : ""}`}>
          <RichText text={m.text} />
        </div>
      )}
      {long && !m.redacted && (
        <button type="button" className="linkbtn mem-more" onClick={() => setOpen((o) => !o)}>
          {open ? "show less" : "show all"}
        </button>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ tool calls
function ToolTimeline({ calls }: { calls: ToolCall[] }) {
  const searches = calls.filter((c) => c.tool === "search_memory").length;
  return (
    <Panel
      title={`What pi did: ${calls.length} tool call${calls.length === 1 ? "" : "s"}`}
      aside={<span className="muted">{searches ? `${searches} memory search${searches === 1 ? "" : "es"} highlighted` : "no memory search"}</span>}
    >
      {calls.length ? (
        <ol className="tl-calls">
          {calls.map((c, i) => {
            const mem = c.tool === "search_memory";
            const query = typeof c.args?.query === "string" ? (c.args.query as string) : undefined;
            return (
              <li key={i} className={`tl-call${mem ? " tl-mem" : ""}`}>
                <span className="tl-n mono">{i + 1}</span>
                <span className="tl-tool mono">{c.tool}</span>
                <span className="tl-arg">
                  {mem && query ? (
                    <span className="tl-query">“{query}”</span>
                  ) : (
                    <span className="mono" title={JSON.stringify(c.args)}>
                      {toolSummary(c)}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="muted">pi made no tool calls.</p>
      )}
    </Panel>
  );
}
