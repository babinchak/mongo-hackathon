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

/** Renders text with `inline code` spans, **bold** runs and optional highlighted terms (case-insensitive). */
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
  const renderCode = (s: string, keyBase: string) =>
    s.split(/(`[^`\n]+`)/g).map((seg, i) =>
      seg.startsWith("`") && seg.endsWith("`") && seg.length > 2 ? (
        <code key={`${keyBase}-c${i}`}>{renderMarks(seg.slice(1, -1), `${keyBase}-c${i}`)}</code>
      ) : (
        <Fragment key={`${keyBase}-t${i}`}>{renderMarks(seg, `${keyBase}-t${i}`)}</Fragment>
      ),
    );
  // **bold** first (it may wrap `code`), then code spans inside each run.
  return (
    <>
      {text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
        i % 2 === 1 ? <strong key={i}>{renderCode(part, `b${i}`)}</strong> : <Fragment key={i}>{renderCode(part, `p${i}`)}</Fragment>,
      )}
    </>
  );
}

/**
 * Plan text: markdown-lite (headings, bullet and numbered lists with nesting, fenced code, `code`, **bold**)
 * with fail-signal marks. Newlines are preserved; nothing is parsed as HTML.
 */
export function PlanText({ text, failSignals }: { text: string; failSignals: string[] }) {
  if (!text?.trim()) return <p className="muted">No final message.</p>;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  const indentOf = (s: string) => Math.min(4, Math.floor(s.replace(/\t/g, "  ").length / 2));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      out.push(
        <pre key={i} className="plan-code">
          {body.join("\n")}
        </pre>,
      );
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      out.push(
        <div key={i} className="plan-h">
          <RichText text={line.replace(/^#+\s/, "")} marks={failSignals} />
        </div>,
      );
      continue;
    }
    if (!line.trim()) {
      out.push(<div key={i} className="plan-gap" />);
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]);
      out.push(
        <div key={i} className="plan-li" style={{ paddingLeft: `${indentOf(li[1]) * 1.3}em` }}>
          <span className={`plan-marker${ordered ? " plan-marker-num" : ""}`}>{ordered ? li[2] : "•"}</span>
          <span>
            <RichText text={li[3]} marks={failSignals} />
          </span>
        </div>,
      );
      continue;
    }
    const lead = /^(\s*)/.exec(line)![1];
    out.push(
      <div key={i} className="plan-line" style={lead ? { paddingLeft: `${indentOf(lead) * 1.3 + 1.3}em` } : undefined}>
        <RichText text={line.trim()} marks={failSignals} />
      </div>,
    );
  }
  return <div className="plan">{out}</div>;
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
