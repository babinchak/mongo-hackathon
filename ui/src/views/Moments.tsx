import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getCases, getMoments, STATIC } from "../api";
import { ErrorBox, FixtureNote, KindTag, Loading, RichText, SnapshotChatNote } from "../components/ui";
import { caseHref, fmtDate, fmtShortDate, fmtTime, isFar, KIND_LABEL, setHashQuery, useAsync, useHashQuery } from "../lib";
import type { MomentDoc, MomentKind } from "../types";

// Same order (and colors) as the Timeline lanes.
const KINDS: MomentKind[] = ["constraint", "decision", "procedure", "fact", "failed_approach"];
type View = "durable" | "rejected";
type Quick = "repeat" | "supersede" | "reason" | null;
const POLL_MS = 20_000;

const saidAgain = (m: MomentDoc) => (m.repeated_by?.length ?? 0) > 0;
const isSuperseded = (m: MomentDoc) => (m.superseded_by?.length ?? 0) > 0 || !isFar(m.superseded_at);
const touchesSupersede = (m: MomentDoc) => isSuperseded(m) || (m.supersedes?.length ?? 0) > 0;
/** What to show as "the rule" for a row. Rejected moments often have an empty `text`. */
const ruleText = (m: MomentDoc) => m.text || m.raw_text || "";

export default function Moments({ repo }: { repo: string }) {
  const q = useHashQuery();
  const openId = q.get("id") ?? undefined;
  const view: View = q.get("view") === "rejected" ? "rejected" : "durable";

  const durable = useAsync(() => getMoments(repo, true), [repo]);
  const rejected = useAsync(() => getMoments(repo, false), [repo]);
  const cases = useAsync(() => getCases(repo), [repo]);

  const [kinds, setKinds] = useState<Set<MomentKind>>(new Set());
  const [quick, setQuick] = useState<Quick>(null);
  const [search, setSearch] = useState("");
  const [needle, setNeedle] = useState("");
  const [cursor, setCursor] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);

  // Debounced search.
  useEffect(() => {
    const t = setTimeout(() => setNeedle(search.trim().toLowerCase()), 180);
    return () => clearTimeout(t);
  }, [search]);

  // Reset filters when the repo changes.
  useEffect(() => {
    setKinds(new Set());
    setQuick(null);
    setSearch("");
    setCursor(-1);
  }, [repo]);

  // Mining runs in the background: while nothing durable has landed yet, poll.
  const minedNothing = durable.data !== undefined && durable.data.length === 0;
  useEffect(() => {
    if (!minedNothing || STATIC) return;
    const t = setInterval(() => {
      durable.reload();
      rejected.reload();
    }, POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minedNothing]);

  const all = (view === "rejected" ? rejected.data : durable.data) ?? [];
  const byId = useMemo(() => {
    const m = new Map<string, { doc: MomentDoc; view: View }>();
    for (const d of durable.data ?? []) m.set(d._id, { doc: d, view: "durable" });
    for (const d of rejected.data ?? []) m.set(d._id, { doc: d, view: "rejected" });
    return m;
  }, [durable.data, rejected.data]);
  const caseByMoment = useMemo(() => new Map((cases.data?.cases ?? []).map((c) => [c.moment_id, c._id])), [cases.data]);

  const filtered = useMemo(() => {
    const terms = needle.split(/\s+/).filter(Boolean);
    return all.filter((m) => {
      if (kinds.size && !kinds.has(m.moment_kind)) return false;
      if (quick === "repeat" && !saidAgain(m)) return false;
      if (quick === "supersede" && !touchesSupersede(m)) return false;
      if (quick === "reason" && !m.refine_reason) return false;
      if (terms.length) {
        const hay = [m.text, m.raw_text, m.topic, m.source_text, m.refine_reason, m._id].join("\n").toLowerCase();
        if (!terms.every((t) => hay.includes(t))) return false;
      }
      return true;
    });
  }, [all, kinds, quick, needle]);

  const filtering = kinds.size > 0 || quick !== null || needle !== "";
  const clearFilters = () => {
    setKinds(new Set());
    setQuick(null);
    setSearch("");
    setNeedle("");
  };

  // Deep link (?id=): switch view / clear filters so the moment is visible, then scroll to it.
  const lastScrolled = useRef<string>();
  useEffect(() => {
    if (!openId) {
      lastScrolled.current = undefined;
      return;
    }
    const hit = byId.get(openId);
    if (!hit) return;
    if (hit.view !== view) {
      setHashQuery({ view: hit.view === "rejected" ? "rejected" : undefined }, { replace: true });
      return;
    }
    const idx = filtered.findIndex((m) => m._id === openId);
    if (idx < 0) {
      // Fresh deep link hidden by filters: clear them. (If the user filtered it away, leave it.)
      if (lastScrolled.current !== openId) clearFilters();
      return;
    }
    setCursor(idx);
    if (lastScrolled.current !== openId) {
      lastScrolled.current = openId;
      requestAnimationFrame(() => document.getElementById(rowId(openId))?.scrollIntoView({ block: "start" }));
    }
  }, [openId, byId, view, filtered]);

  const open = (id: string | undefined, push = false) => setHashQuery({ id }, { replace: !push });
  const jump = (id: string) => {
    const hit = byId.get(id);
    lastScrolled.current = undefined;
    setHashQuery({ id, view: hit?.view === "rejected" ? "rejected" : undefined });
  };
  const setView = (v: View) => {
    setCursor(-1);
    setQuick(null);
    setHashQuery({ view: v === "rejected" ? "rejected" : undefined, id: undefined });
  };

  // Keyboard: j/k move (and carry the open row along), enter/o toggles, esc closes, / searches.
  const kb = useRef({ filtered, cursor, openId });
  kb.current = { filtered, cursor, openId };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
        if (e.key === "Escape") t.blur();
        return;
      }
      const { filtered: list, cursor: cur, openId: oid } = kb.current;
      const move = (d: number) => {
        if (!list.length) return;
        const next = Math.max(0, Math.min(list.length - 1, (cur < 0 ? (d > 0 ? -1 : list.length) : cur) + d));
        setCursor(next);
        const id = list[next]._id;
        if (oid) open(id);
        requestAnimationFrame(() => document.getElementById(rowId(id))?.scrollIntoView({ block: "nearest" }));
      };
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if ((e.key === "Enter" || e.key === "o") && cur >= 0 && list[cur]) {
        e.preventDefault();
        open(oid === list[cur]._id ? undefined : list[cur]._id);
      } else if (e.key === "Escape" && oid) {
        open(undefined);
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const current = view === "rejected" ? rejected : durable;
  // Nothing mined at all yet: skip the (all-zero) summary and filters, show only the empty state.
  const nothingYet = minedNothing && rejected.data !== undefined && rejected.data.length === 0 && !filtering;
  const kindCount = (k: MomentKind) => all.filter((m) => m.moment_kind === k).length;
  const kindsShown = view === "rejected" && all.some((m) => m.moment_kind === "none") ? [...KINDS, "none" as MomentKind] : KINDS;
  const d = durable.data ?? [];
  const nRepeats = d.reduce((n, m) => n + (m.repeats?.length ?? 0), 0);
  const nSupersessions = d.reduce((n, m) => n + (m.supersedes?.length ?? 0), 0);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Moments</h1>
          <p className="lede">
            {STATIC
              ? "Durable project knowledge the miner pulled out of developer turns. Expand a row to see the mined rule, the audit and related moments."
              : "Durable project knowledge the miner pulled out of developer turns. Expand a row to put the mined rule next to what the developer actually said."}
          </p>
        </div>
      </div>
      <FixtureNote data={[durable.data, rejected.data]} />

      {nothingYet
        ? null
        : durable.data && (
            <div className="m-summary">
              <strong>{d.length.toLocaleString("en-US")} durable</strong>
              {KINDS.map((k) => {
                const n = d.filter((m) => m.moment_kind === k).length;
                return (
                  <span key={k} className="m-summary-item">
                    <span className={`kind-swatch kind-${k}`} aria-hidden />
                    {n} {KIND_LABEL[k].toLowerCase()}
                  </span>
                );
              })}
              <span className="m-summary-item">
                {nRepeats} repeat{nRepeats === 1 ? "" : "s"}
              </span>
              <span className="m-summary-item">
                {nSupersessions} supersession{nSupersessions === 1 ? "" : "s"}
              </span>
              {rejected.data && (
                <span className="m-summary-item muted">
                  {rejected.data.length.toLocaleString("en-US")} rejected ({rejected.data.filter((m) => m.refine_reason).length} with an
                  audit reason)
                </span>
              )}
            </div>
          )}

      {!nothingYet && (
        <>
          <div className="m-toolbar">
            <div className="seg" role="tablist" aria-label="Audit result">
              <button
                type="button"
                role="tab"
                aria-selected={view === "durable"}
                className={view === "durable" ? "active" : ""}
                onClick={() => setView("durable")}
              >
                Durable <span className="count">{durable.data?.length ?? "…"}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === "rejected"}
                className={view === "rejected" ? "active" : ""}
                onClick={() => setView("rejected")}
              >
                Rejected by audit <span className="count">{rejected.data?.length ?? "…"}</span>
              </button>
            </div>
            <div className="m-chips" aria-label="Kind">
              {kindsShown.map((k) => {
                const n = kindCount(k);
                const on = kinds.has(k);
                return (
                  <button
                    key={k}
                    type="button"
                    className={`fchip${on ? " active" : ""}`}
                    aria-pressed={on}
                    disabled={!n && !on}
                    onClick={() =>
                      setKinds((s) => {
                        const next = new Set(s);
                        if (next.has(k)) next.delete(k);
                        else next.add(k);
                        return next;
                      })
                    }
                  >
                    <span className={`kind-swatch kind-${k}`} aria-hidden />
                    {KIND_LABEL[k]} <span className="count">{n}</span>
                  </button>
                );
              })}
            </div>
            <div className="m-chips" aria-label="Relations">
              <button
                type="button"
                className={`fchip${quick === "repeat" ? " active" : ""}`}
                aria-pressed={quick === "repeat"}
                disabled={!all.some(saidAgain) && quick !== "repeat"}
                onClick={() => setQuick((x) => (x === "repeat" ? null : "repeat"))}
                title="The developer had to say this again later"
              >
                said again <span className="count">{all.filter(saidAgain).length}</span>
              </button>
              <button
                type="button"
                className={`fchip${quick === "supersede" ? " active" : ""}`}
                aria-pressed={quick === "supersede"}
                disabled={!all.some(touchesSupersede) && quick !== "supersede"}
                onClick={() => setQuick((x) => (x === "supersede" ? null : "supersede"))}
                title="Replaced by a later decision, or replaces an earlier one"
              >
                superseded / supersedes <span className="count">{all.filter(touchesSupersede).length}</span>
              </button>
              {view === "rejected" && (
                <button
                  type="button"
                  className={`fchip${quick === "reason" ? " active" : ""}`}
                  aria-pressed={quick === "reason"}
                  onClick={() => setQuick((x) => (x === "reason" ? null : "reason"))}
                  title="Typed by the miner, then rejected by the audit with a reason (the rest were never typed)"
                >
                  has audit reason <span className="count">{all.filter((m) => m.refine_reason).length}</span>
                </button>
              )}
            </div>
            <input
              ref={searchRef}
              type="text"
              className="m-search"
              placeholder={STATIC ? "Search rule, topic, audit reason…  ( / )" : "Search rule, topic, developer’s words…  ( / )"}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search moments"
            />
          </div>

          <div className="m-meta muted small">
            <span>
              {filtering ? `${filtered.length} of ${all.length}` : `${all.length}`} shown
              {filtering && (
                <button type="button" className="linkbtn" onClick={clearFilters}>
                  clear filters
                </button>
              )}
            </span>
            <span className="kbd-hint">
              <kbd>j</kbd>
              <kbd>k</kbd> move · <kbd>enter</kbd> expand · <kbd>esc</kbd> close · <kbd>/</kbd> search
            </span>
          </div>
        </>
      )}

      {current.error ? (
        <ErrorBox error={current.error} retry={current.reload} />
      ) : !current.data ? (
        <Loading what="moments" />
      ) : !all.length ? (
        view === "durable" && STATIC ? (
          <div className="empty-card">
            <strong>No durable moments for {repo} in this snapshot.</strong>
          </div>
        ) : view === "durable" ? (
          <div className="empty-card mining">
            <span className="mining-dots" aria-hidden>
              <span />
              <span />
              <span />
            </span>
            <strong>Moments are being mined…</strong>
            <span>
              The miner is reading {repo}’s developer turns and writes durable moments to Atlas as it goes. This page checks again every{" "}
              {POLL_MS / 1000} s.
            </span>
            <button type="button" className="btn btn-small" onClick={() => (durable.reload(), rejected.reload())}>
              Check now
            </button>
          </div>
        ) : (
          <div className="empty-card">
            <strong>Nothing rejected by the audit.</strong>
            <span>Candidates the audit throws out (not durable, too vague, already in the repo) land here with the reason.</span>
          </div>
        )
      ) : !filtered.length ? (
        <div className="empty-card">
          <strong>No moments match.</strong>
          <button type="button" className="btn btn-small" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      ) : (
        <div className="m-list panel panel-flush" role="list">
          {filtered.map((m, i) => (
            <MomentRow
              key={m._id}
              m={m}
              view={view}
              isCursor={i === cursor}
              isOpen={m._id === openId}
              caseId={caseByMoment.get(m._id)}
              byId={byId}
              onToggle={() => {
                setCursor(i);
                open(m._id === openId ? undefined : m._id);
              }}
              onJump={jump}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const rowId = (id: string) => `m-${id}`;

function MomentRow({
  m,
  view,
  isCursor,
  isOpen,
  caseId,
  byId,
  onToggle,
  onJump,
}: {
  m: MomentDoc;
  view: View;
  isCursor: boolean;
  isOpen: boolean;
  caseId?: string;
  byId: Map<string, { doc: MomentDoc; view: View }>;
  onToggle: () => void;
  onJump: (id: string) => void;
}) {
  const rule = ruleText(m);
  const nAgain = m.repeated_by?.length ?? 0;
  const nSup = m.supersedes?.length ?? 0;
  return (
    <div
      id={rowId(m._id)}
      role="listitem"
      className={`m-row${isCursor ? " is-cursor" : ""}${isOpen ? " is-open" : ""}${isSuperseded(m) ? " is-superseded" : ""}`}
    >
      <button type="button" className="m-line" onClick={onToggle} aria-expanded={isOpen}>
        <span className="m-date mono" title={`${fmtDate(m.ts)} ${fmtTime(m.ts)} UTC`}>
          {fmtShortDate(m.ts)}
        </span>
        <span className="m-kind">
          <KindTag k={m.moment_kind} />
        </span>
        <span className="m-topic" title={m.topic}>
          {m.topic || "-"}
        </span>
        <span className="m-text">
          {rule ? (
            <RichText text={rule} />
          ) : STATIC ? (
            <span className="muted m-norule">no rule extracted</span>
          ) : (
            <span className="muted m-norule">no rule extracted · “{clip(m.source_text ?? "", 140)}”</span>
          )}
          {view === "rejected" && m.refine_reason && <span className="m-reason">{m.refine_reason}</span>}
        </span>
        <span className="m-badges">
          {nAgain > 0 && <span className="flag flag-accent">said again ×{nAgain}</span>}
          {(m.repeats?.length ?? 0) > 0 && <span className="flag flag-accent-soft">repeat</span>}
          {isSuperseded(m) && <span className="flag flag-warn">superseded</span>}
          {nSup > 0 && <span className="flag">supersedes {nSup}</span>}
          {caseId && <span className="flag flag-case">case</span>}
        </span>
      </button>
      {isOpen && <MomentDetail m={m} caseId={caseId} byId={byId} onJump={onJump} />}
    </div>
  );
}

function MomentDetail({
  m,
  caseId,
  byId,
  onJump,
}: {
  m: MomentDoc;
  caseId?: string;
  byId: Map<string, { doc: MomentDoc; view: View }>;
  onJump: (id: string) => void;
}) {
  const rawDiffers = !!m.raw_text && m.raw_text.trim() !== (m.text ?? "").trim();
  const related: { rel: string; tone: string; ids: string[] }[] = [
    { rel: "Supersedes", tone: "old", ids: m.supersedes ?? [] },
    { rel: "Superseded by", tone: "new", ids: m.superseded_by ?? [] },
    { rel: "Repeats earlier", tone: "repeat", ids: m.repeats ?? [] },
    { rel: "Said again", tone: "repeat", ids: m.repeated_by ?? [] },
  ];
  const nRelated = related.reduce((n, r) => n + r.ids.length, 0);
  return (
    <div className="m-detail">
      <div className="m-compare">
        <section className="m-said">
          <h3>Developer said</h3>
          {STATIC ? (
            <SnapshotChatNote />
          ) : m.source_text ? (
            <blockquote className="m-source">{m.source_text}</blockquote>
          ) : (
            <p className="muted small">Source turn text unavailable.</p>
          )}
          <div className="m-facts muted small">
            <span className="mono" title="session">
              {m.session_id.slice(0, 8)}
            </span>
            <span className="mono" title="source turn">
              turn {m.source_turn_id.split("#").pop()}
            </span>
            {m.pushback && <span>{m.pushback.replace("_", " ")}</span>}
            {m.evidence?.length > 1 && <span title={m.evidence.join("\n")}>{m.evidence.length} evidence turns</span>}
          </div>
        </section>
        <section className="m-mined">
          <h3>Mined rule</h3>
          {m.text ? (
            <p className="m-rule">
              <RichText text={m.text} />
            </p>
          ) : (
            <p className="muted">No rule text (the audit dropped it).</p>
          )}
          {rawDiffers && (
            <div className="m-sub">
              <span className="m-sub-k">Before audit</span>
              <span className="m-raw">
                <RichText text={m.raw_text!} />
              </span>
            </div>
          )}
          {m.refine_reason && (
            <div className="m-sub">
              <span className="m-sub-k">Audit</span>
              <span className={m.durable ? "" : "m-reason"}>{m.refine_reason}</span>
            </div>
          )}
          <div className="m-facts muted small">
            <span className="confidence" title={`confidence ${m.confidence}/5`}>
              {"●".repeat(Math.max(0, Math.min(5, m.confidence)))}
              <span className="dim">{"●".repeat(Math.max(0, 5 - m.confidence))}</span>
            </span>
            <span>{fmtDate(m.ts)}</span>
            {!isFar(m.superseded_at) && <span className="flag flag-warn">superseded {fmtShortDate(m.superseded_at)}</span>}
            {m.refined && <span>refined by audit</span>}
            {caseId && (
              <a href={caseHref(caseId)} onClick={(e) => e.stopPropagation()}>
                eval case →
              </a>
            )}
            <span className="mono m-id" title={m._id}>
              {m._id}
            </span>
          </div>
        </section>
      </div>
      {nRelated > 0 && (
        <div className="m-related">
          {related.map(({ rel, tone, ids }) =>
            ids.map((id) => {
              const hit = byId.get(id)?.doc;
              return (
                <button key={`${rel}-${id}`} type="button" className={`m-mini m-mini-${tone}`} onClick={() => onJump(id)} disabled={!hit}>
                  <span className="m-mini-rel">{rel}</span>
                  <span className="m-mini-date mono">{hit ? fmtShortDate(hit.ts) : ""}</span>
                  {hit ? <span className={`kind-swatch kind-${hit.moment_kind}`} aria-hidden /> : <span />}
                  <span className="m-mini-text">
                    {hit ? clip(ruleText(hit) || hit.source_text || "", 220) : <span className="mono muted">{id} (not loaded)</span>}
                  </span>
                  {hit && (
                    <span className="m-mini-go" aria-hidden>
                      ↗
                    </span>
                  )}
                </button>
              );
            }),
          )}
        </div>
      )}
    </div>
  );
}

function clip(s: string, n: number): ReactNode {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
