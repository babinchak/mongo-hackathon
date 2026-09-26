import { Fragment, type ReactNode } from "react";
import type { CaseStatus, MomentKind, Scenario, Verdict } from "../types";
import { KIND_LABEL, SCENARIO_LABEL } from "../lib";
import { fixtureReason } from "../api";

const VERDICT_ICON: Record<Verdict, string> = { pass: "✓", fail: "✕", error: "!" };

export function VerdictChip({ v, big }: { v: Verdict; big?: boolean }) {
  return (
    <span className={`verdict verdict-${v}${big ? " verdict-big" : ""}`}>
      <span aria-hidden>{VERDICT_ICON[v]}</span> {v}
    </span>
  );
}

/** Tiny square with icon for dense run matrices. */
export function VerdictDot({ v, title, onClick, active }: { v: Verdict; title?: string; onClick?: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      className={`vdot vdot-${v}${active ? " vdot-active" : ""}`}
      title={title ?? v}
      onClick={onClick}
      aria-label={title ?? v}
    >
      {VERDICT_ICON[v]}
    </button>
  );
}

export function ScenarioTag({ s }: { s: Scenario }) {
  return <span className={`tag tag-scn tag-${s}`}>{SCENARIO_LABEL[s] ?? s}</span>;
}

export function KindTag({ k }: { k: MomentKind }) {
  return (
    <span className="tag tag-kind">
      <span className={`kind-swatch kind-${k}`} aria-hidden />
      {KIND_LABEL[k] ?? k}
    </span>
  );
}

export function StatusTag({ s }: { s: CaseStatus }) {
  return <span className={`tag tag-status status-${s}`}>{s.replace("_", " ")}</span>;
}

export function Loading({ what }: { what?: string }) {
  return <div className="loading">Loading{what ? ` ${what}` : ""}…</div>;
}

export function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="errorbox">
      <strong>Couldn’t load.</strong> <span className="mono">{error}</span>
      {retry && (
        <button type="button" className="btn btn-small" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Panel({
  title,
  aside,
  children,
  className,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className ?? ""}`}>
      {(title || aside) && (
        <header className="panel-head">
          {title && <h2>{title}</h2>}
          {aside && <div className="panel-aside">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** Renders text with `inline code` spans and optional highlighted terms (case-insensitive). */
export function RichText({ text, marks, markClass = "mark-fail" }: { text: string; marks?: string[]; markClass?: string }) {
  const terms = (marks ?? []).filter(Boolean);
  const re = terms.length ? new RegExp(`(${terms.map(escapeRe).join("|")})`, "gi") : null;
  const renderMarks = (s: string, keyBase: string) => {
    if (!re) return s;
    return s.split(re).map((part, i) =>
      i % 2 === 1 ? (
        <mark key={`${keyBase}-${i}`} className={markClass}>
          {part}
        </mark>
      ) : (
        <Fragment key={`${keyBase}-${i}`}>{part}</Fragment>
      ),
    );
  };
  const segs = text.split(/(`[^`\n]+`)/g);
  return (
    <>
      {segs.map((seg, i) =>
        seg.startsWith("`") && seg.endsWith("`") && seg.length > 2 ? (
          <code key={i}>{renderMarks(seg.slice(1, -1), `c${i}`)}</code>
        ) : (
          <Fragment key={i}>{renderMarks(seg, `t${i}`)}</Fragment>
        ),
      )}
    </>
  );
}

/** Plan text: markdown-lite (## headings, numbered lines) with fail-signal marks. */
export function PlanText({ text, failSignals }: { text: string; failSignals: string[] }) {
  if (!text.trim()) return <p className="muted">No final message.</p>;
  return (
    <div className="plan">
      {text.split("\n").map((line, i) => {
        if (/^#{1,4}\s/.test(line))
          return (
            <div key={i} className="plan-h">
              {line.replace(/^#+\s/, "")}
            </div>
          );
        if (!line.trim()) return <div key={i} className="plan-gap" />;
        return (
          <div key={i} className="plan-line">
            <RichText text={line} marks={failSignals} />
          </div>
        );
      })}
    </div>
  );
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function Meter({ value, className }: { value: number | null; className?: string }) {
  if (value == null) return null;
  return (
    <span className={`meter ${className ?? ""}`}>
      <span className="meter-fill" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </span>
  );
}

/** Per-page note shown only when one of this page's responses came from fixtures. */
export function FixtureNote({ data }: { data: unknown[] }) {
  const reasons = [...new Set(data.map(fixtureReason).filter(Boolean))];
  if (!reasons.length) return null;
  return (
    <div className="fixture-note" role="status">
      <span className="source-dot" aria-hidden />
      <span>
        <strong>Synthetic fixtures on this page</strong> <span className="muted">· {reasons.join("; ")}</span>
      </span>
    </div>
  );
}

/** Static snapshot only: stands in wherever the UI would show the developer's original chat text. */
export function SnapshotChatNote() {
  return (
    <p className="snapshot-note muted small">
      Original chat text isn’t published in the hosted snapshot (it’s from the SWE-chat dataset); run locally to see it.
    </p>
  );
}

/** Static snapshot only: explains why an action that needs the local harness is unavailable. */
export function SnapshotReadOnlyNote({ children }: { children: ReactNode }) {
  return (
    <div className="snapshot-note snapshot-note-box muted small" role="note">
      {children}
    </div>
  );
}
