import { useEffect, useMemo, useRef, useState } from "react";
import { getTimeline } from "../api";
import { ErrorBox, FixtureNote, KindTag, Loading, Panel } from "../components/ui";
import { fmtDate, fmtShortDate, href, isFar, KIND_LABEL, momentHref, parseDate, useAsync } from "../lib";
import type { MomentDoc, MomentKind, SessionDoc } from "../types";

// Same order (and colors) as the Moments browser chips.
const KINDS: MomentKind[] = ["constraint", "decision", "procedure", "fact", "failed_approach"];
const W = 1200;
const L = 132; // label gutter
const R = 18;
const TOP = 10;
const SESS_H = 56;
const LANE_H = 76;
const LANES_TOP = TOP + SESS_H + 10;
const AXIS_H = 26;
const H = LANES_TOP + KINDS.length * LANE_H + AXIS_H;
const DAY = 86_400_000;

type Hover = { kind: "m"; id: string; x: number; y: number } | { kind: "s"; id: string; x: number; y: number };
type Arc = { a: MomentDoc; b: MomentDoc; type: "supersede" | "repeat" };

/** Deterministic 0..1 from an id, so dots don't jump between renders. */
function hash01(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10007) / 10007;
}

function pickTicks(t0: number, t1: number): { ts: number[]; fmt: (t: number) => string } {
  const span = (t1 - t0) / DAY;
  const dayFmt = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  for (const step of [1, 2, 7, 14]) {
    if (span / step <= 12) {
      const ts: number[] = [];
      const d = new Date(t0);
      d.setUTCHours(0, 0, 0, 0);
      if (step === 7 || step === 14)
        while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); // Mondays
      else d.setUTCDate(d.getUTCDate() + 1);
      for (; +d <= t1; d.setUTCDate(d.getUTCDate() + step)) if (+d >= t0) ts.push(+d);
      return { ts, fmt: dayFmt };
    }
  }
  const monthStep = span / 30 <= 12 ? 1 : span / 30 <= 24 ? 2 : 3;
  const ts: number[] = [];
  const d = new Date(t0);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  for (; +d <= t1; d.setUTCMonth(d.getUTCMonth() + monthStep)) if (+d >= t0) ts.push(+d);
  return { ts, fmt: (t) => new Date(t).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) };
}

export default function Timeline({ repo }: { repo: string }) {
  const tl = useAsync(() => getTimeline(repo), [repo]);
  const wrap = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [brush, setBrush] = useState<[number, number] | null>(null);
  const [showSup, setShowSup] = useState(true);
  const [showRep, setShowRep] = useState(true);

  useEffect(() => {
    setZoom(null);
    setHover(null);
  }, [repo]);

  const model = useMemo(() => {
    if (!tl.data) return null;
    const { sessions, moments } = tl.data;
    const ms = moments.filter((m) => m.moment_kind !== "none" && KINDS.includes(m.moment_kind));
    const times = [...sessions.map((s) => +parseDate(s.started_at)), ...ms.map((m) => +parseDate(m.ts))].filter((t) => !Number.isNaN(t));
    if (!times.length)
      return { sessions, ms, byId: new Map<string, MomentDoc>(), arcs: [] as Arc[], full: [0, 1] as [number, number], empty: true };
    const lo = Math.min(...times);
    const hi = Math.max(...times);
    const pad = Math.max((hi - lo) * 0.015, DAY / 4);
    const byId = new Map(ms.map((m) => [m._id, m]));
    const arcs: Arc[] = [];
    const seen = new Set<string>();
    const add = (a: MomentDoc | undefined, b: MomentDoc | undefined, type: Arc["type"]) => {
      if (!a || !b || a._id === b._id) return;
      const [p, q] = +parseDate(a.ts) <= +parseDate(b.ts) ? [a, b] : [b, a];
      const key = `${type}:${p._id}>${q._id}`;
      if (seen.has(key)) return;
      seen.add(key);
      arcs.push({ a: p, b: q, type });
    };
    for (const m of ms) {
      for (const id of m.superseded_by ?? []) add(m, byId.get(id), "supersede");
      for (const id of m.supersedes ?? []) add(byId.get(id), m, "supersede");
      for (const id of m.repeated_by ?? []) add(m, byId.get(id), "repeat");
      for (const id of m.repeats ?? []) add(byId.get(id), m, "repeat");
    }
    return { sessions, ms, byId, arcs, full: [lo - pad, hi + pad] as [number, number], empty: false };
  }, [tl.data]);

  const [t0, t1] = zoom ?? model?.full ?? [0, 1];
  const x = (t: string | number) => L + (((typeof t === "number" ? t : +parseDate(t)) - t0) / (t1 - t0)) * (W - L - R);
  const tAt = (px: number) => t0 + ((px - L) / (W - L - R)) * (t1 - t0);
  const laneY = (k: MomentKind) => LANES_TOP + KINDS.indexOf(k) * LANE_H + LANE_H / 2;
  const pos = (m: MomentDoc) => ({ cx: x(m.ts), cy: laneY(m.moment_kind) + (hash01(m._id) - 0.5) * (LANE_H - 14) });

  // Heavy base layer, memoized: only re-rendered on data / zoom / arc toggles, not on hover.
  const base = useMemo(() => {
    if (!model || model.empty) return null;
    const { sessions, ms, arcs } = model;
    const maxP = Math.sqrt(Math.max(...sessions.map((s) => s.prompts), 1));
    const barW = Math.max(1.5, Math.min(4, ((W - L - R) / ((t1 - t0) / DAY)) * 0.08));
    const inView = (t: number) => t >= t0 - DAY && t <= t1 + DAY;
    return (
      <g clipPath="url(#tl-clip)">
        {sessions.map((s) => {
          const h = Math.max(2, (Math.sqrt(s.prompts) / maxP) * (SESS_H - 6));
          return (
            <rect
              key={s._id}
              data-sid={s._id}
              x={x(s.started_at) - barW / 2}
              y={TOP + SESS_H - h}
              width={barW}
              height={h}
              rx={1}
              className="sess-bar"
            />
          );
        })}
        {arcs
          .filter((r) => (r.type === "supersede" ? showSup : showRep))
          .map(({ a, b, type }) => {
            const p = pos(a);
            const q = pos(b);
            if (!inView(+parseDate(a.ts)) && !inView(+parseDate(b.ts)) && (p.cx > W || q.cx < L)) return null;
            return <path key={`${type}-${a._id}-${b._id}`} d={arcPath(p, q)} className={`arc-${type}`} />;
          })}
        {ms.map((m) => {
          const { cx, cy } = pos(m);
          const c = m.has_case;
          return (
            <g
              key={m._id}
              data-mid={m._id}
              className={`mdot kind-fill-${m.moment_kind}${isFar(m.superseded_at) ? "" : " mdot-superseded"}${c ? " mdot-case" : ""}`}
            >
              {c && <circle cx={cx} cy={cy} r={6.5} className="mdot-ring" />}
              <circle cx={cx} cy={cy} r={c ? 4 : 3} />
            </g>
          );
        })}
      </g>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, t0, t1, showSup, showRep]);

  if (tl.error) return <ErrorBox error={tl.error} retry={tl.reload} />;
  if (!tl.data || !model) return <Loading what="timeline" />;
  const { sessions, ms, byId, arcs } = model;

  const toSvgX = (clientX: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * W;
  };
  const counts = Object.fromEntries(KINDS.map((k) => [k, ms.filter((m) => m.moment_kind === k).length]));
  const nSup = arcs.filter((a) => a.type === "supersede").length;
  const nRep = arcs.filter((a) => a.type === "repeat").length;

  // Focus layer: whatever the pointer is on, plus everything linked to it.
  let focus: { dots: MomentDoc[]; arcs: Arc[] } | null = null;
  if (hover?.kind === "m" && byId.get(hover.id)) {
    const fa = arcs.filter((a) => (a.a._id === hover.id || a.b._id === hover.id) && (a.type === "supersede" ? showSup : showRep));
    const dots = new Map<string, MomentDoc>([[hover.id, byId.get(hover.id)!]]);
    fa.forEach((a) => (dots.set(a.a._id, a.a), dots.set(a.b._id, a.b)));
    focus = { dots: [...dots.values()], arcs: fa };
  } else if (hover?.kind === "s") {
    focus = { dots: ms.filter((m) => m.session_id === hover.id), arcs: [] };
  }

  const ticks = pickTicks(t0, t1);
  const hm = hover?.kind === "m" ? byId.get(hover.id) : undefined;
  const hs = hover?.kind === "s" ? sessions.find((s) => s._id === hover.id) : undefined;
  const tipW = 330;
  const wrapW = wrap.current?.clientWidth ?? 900;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Project history</h1>
          <p className="lede">
            {sessions.length.toLocaleString("en-US")} agent sessions and {ms.length.toLocaleString("en-US")} durable moments in {repo}, by
            kind. Arcs link a decision to the one that replaced it, and a correction to the time it had to be said again. Ringed dots have
            an eval case. Click a dot to open it in Moments.
          </p>
        </div>
      </div>
      <FixtureNote data={[tl.data]} />
      {model.empty ? (
        <div className="empty-card">
          <strong>No sessions for {repo} yet.</strong>
          <span>Ingest the repo’s SWE-chat sessions first; moments appear here as they are mined.</span>
        </div>
      ) : (
        <Panel
          title="Timeline"
          aside={
            <div className="legend">
              {KINDS.map((k) => (
                <span key={k} className="legend-item">
                  <KindTag k={k} /> <span className="muted">{counts[k]}</span>
                </span>
              ))}
              <label className="legend-item legend-toggle">
                <input type="checkbox" checked={showSup} onChange={(e) => setShowSup(e.target.checked)} />
                <svg width="28" height="10" aria-hidden>
                  <path d="M2 8 Q14 -2 26 8" className="arc-supersede arc-legend" />
                </svg>
                superseded by <span className="muted">{nSup}</span>
              </label>
              <label className="legend-item legend-toggle">
                <input type="checkbox" checked={showRep} onChange={(e) => setShowRep(e.target.checked)} />
                <svg width="28" height="10" aria-hidden>
                  <path d="M2 8 Q14 -2 26 8" className="arc-repeat arc-legend" />
                </svg>
                said again <span className="muted">{nRep}</span>
              </label>
            </div>
          }
        >
          <div className="tl-bar muted small">
            <span>
              {zoom ? (
                <>
                  Showing {fmtShortDate(new Date(t0).toISOString())} – {fmtDate(new Date(t1).toISOString())}{" "}
                  <button type="button" className="linkbtn" onClick={() => setZoom(null)}>
                    reset zoom
                  </button>
                </>
              ) : (
                <>
                  {fmtDate(new Date(model.full[0]).toISOString())} – {fmtDate(new Date(model.full[1]).toISOString())}
                </>
              )}
            </span>
            <span>Drag across the chart to zoom into a date range · double-click to reset</span>
          </div>
          <div className="timeline" ref={wrap} onMouseLeave={() => (setHover(null), setBrush(null))}>
            <svg
              ref={svgRef}
              viewBox={`0 0 ${W} ${H}`}
              width="100%"
              role="img"
              aria-label="Timeline of sessions and moments"
              className={`${focus ? "has-focus" : ""}${brush ? " brushing" : ""}`}
              onMouseOver={(e) => {
                const t = e.target as Element;
                const el = t.closest("[data-mid],[data-sid]");
                if (!el) return setHover(null);
                const r = wrap.current!.getBoundingClientRect();
                const pt = { x: e.clientX - r.left, y: e.clientY - r.top };
                const mid = el.getAttribute("data-mid");
                const sid = el.getAttribute("data-sid");
                if (mid && (hover?.kind !== "m" || hover.id !== mid)) setHover({ kind: "m", id: mid, ...pt });
                else if (sid && (hover?.kind !== "s" || hover.id !== sid)) setHover({ kind: "s", id: sid, ...pt });
              }}
              onMouseDown={(e) => {
                if (e.button !== 0 || (e.target as Element).closest("[data-mid]")) return;
                const sx = toSvgX(e.clientX);
                if (sx < L || sx > W - R) return;
                e.preventDefault();
                setBrush([sx, sx]);
              }}
              onMouseMove={(e) => {
                if (brush) setBrush([brush[0], Math.max(L, Math.min(W - R, toSvgX(e.clientX)))]);
              }}
              onMouseUp={() => {
                if (!brush) return;
                const [a, b] = [Math.min(...brush), Math.max(...brush)];
                setBrush(null);
                if (b - a > 8) {
                  const lo = tAt(a);
                  const hi = tAt(b);
                  if (hi - lo > DAY / 12) setZoom([lo, hi]);
                }
              }}
              onDoubleClick={() => setZoom(null)}
              onClick={(e) => {
                const el = (e.target as Element).closest("[data-mid]");
                const id = el?.getAttribute("data-mid");
                if (id) window.location.hash = momentHref(id).slice(1);
              }}
            >
              <defs>
                <clipPath id="tl-clip">
                  <rect x={L} y={0} width={W - L - R} height={H - AXIS_H + 2} />
                </clipPath>
              </defs>
              {ticks.ts.map((t) => (
                <g key={t}>
                  <line x1={x(t)} x2={x(t)} y1={TOP} y2={H - AXIS_H} className="grid" />
                  <text x={x(t) + 4} y={H - 8} className="axis-label">
                    {ticks.fmt(t)}
                  </text>
                </g>
              ))}
              <text x={12} y={TOP + SESS_H / 2 + 4} className="lane-label">
                Sessions
              </text>
              <text x={12} y={TOP + SESS_H / 2 + 20} className="lane-sub">
                height = prompts
              </text>
              <line x1={L} x2={W - R} y1={TOP + SESS_H} y2={TOP + SESS_H} className="baseline" />
              {KINDS.map((k, i) => (
                <g key={k}>
                  <rect x={L} y={LANES_TOP + i * LANE_H} width={W - L - R} height={LANE_H} className={i % 2 ? "lane lane-alt" : "lane"} />
                  <text x={12} y={laneY(k) + 4} className="lane-label">
                    {KIND_LABEL[k]}
                  </text>
                  <text x={12} y={laneY(k) + 20} className="lane-sub">
                    {counts[k]}
                  </text>
                </g>
              ))}
              <g className="tl-base">{base}</g>
              {focus && (
                <g className="tl-focus" clipPath="url(#tl-clip)" pointerEvents="none">
                  {focus.arcs.map(({ a, b, type }) => (
                    <path key={`f-${type}-${a._id}-${b._id}`} d={arcPath(pos(a), pos(b))} className={`arc-${type} arc-on`} />
                  ))}
                  {focus.dots.map((m) => {
                    const { cx, cy } = pos(m);
                    return (
                      <g key={`f-${m._id}`} className={`mdot kind-fill-${m.moment_kind}`}>
                        <circle cx={cx} cy={cy} r={m._id === hover?.id ? 6 : 4.5} className="mdot-on" />
                      </g>
                    );
                  })}
                  {hs && <rect x={x(hs.started_at) - 2} y={TOP} width={4} height={SESS_H} className="sess-on" />}
                </g>
              )}
              {brush && (
                <rect x={Math.min(...brush)} y={TOP} width={Math.abs(brush[1] - brush[0])} height={H - AXIS_H - TOP} className="tl-brush" />
              )}
            </svg>
            {hover && !brush && (hm || hs) && (
              <div className="tip" style={{ left: Math.max(0, Math.min(hover.x + 14, wrapW - tipW - 4)), top: hover.y + 16 }}>
                {hm && <MomentTip m={hm} />}
                {hs && <SessionTip s={hs} n={focus?.dots.length ?? 0} />}
              </div>
            )}
          </div>
        </Panel>
      )}
      <p className="muted small">
        Faded dots are superseded. Hover a session bar to light up the moments mined from it. Full list with filters in{" "}
        <a href={href("/moments")}>Moments</a>.
      </p>
    </div>
  );
}

function arcPath(p: { cx: number; cy: number }, q: { cx: number; cy: number }) {
  const lift = Math.min(46, Math.abs(q.cx - p.cx) / 3 + 10);
  const mx = (p.cx + q.cx) / 2;
  const my = Math.min(p.cy, q.cy) - lift;
  return `M${p.cx} ${p.cy} Q${mx} ${my} ${q.cx} ${q.cy}`;
}

function MomentTip({ m }: { m: MomentDoc }) {
  const again = m.repeated_by?.length ?? 0;
  return (
    <>
      <div className="tip-head">
        <KindTag k={m.moment_kind} /> <span>{fmtDate(m.ts)}</span>
      </div>
      <div className="tip-text">{m.text}</div>
      <div className="muted">{m.topic}</div>
      <div className="chips">
        {again > 0 && <span className="flag flag-accent">said again ×{again}</span>}
        {(m.repeats?.length ?? 0) > 0 && <span className="flag flag-accent-soft">repeat</span>}
        {!isFar(m.superseded_at) && <span className="flag flag-warn">superseded {fmtShortDate(m.superseded_at)}</span>}
        {(m.supersedes?.length ?? 0) > 0 && <span className="flag">supersedes {m.supersedes.length}</span>}
        {m.has_case && <span className="flag flag-case">eval case</span>}
      </div>
      <div className="tip-case">Click to open in Moments</div>
    </>
  );
}

function SessionTip({ s, n }: { s: SessionDoc; n: number }) {
  return (
    <>
      <div className="tip-head">
        <strong>Session</strong> <span>{fmtDate(s.started_at)}</span>
      </div>
      <div className="mono muted">{s._id}</div>
      <div>
        {s.prompts} prompts · {s.branch || "no branch"} · {s.agent}
      </div>
      <div className="muted">
        {n} durable moment{n === 1 ? "" : "s"} mined
      </div>
    </>
  );
}
