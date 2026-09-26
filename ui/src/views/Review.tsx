import { useState } from "react";
import { getCases, getFunnel, postReview } from "../api";
import { ErrorBox, FixtureNote, Loading, RichText, ScenarioTag, StatusTag, VerdictChip } from "../components/ui";
import { caseHref, fmtShortDate, href, useAsync } from "../lib";
import type { CaseDoc, CasesResponse, Funnel } from "../types";

const STAGES: { key: keyof Funnel; label: string; note: string }[] = [
  { key: "events", label: "Events", note: "prompts + replies ingested" },
  { key: "pushback", label: "Pushback", note: "corrections, failure reports, rejections" },
  { key: "durable_moments", label: "Durable moments", note: "typed, still true later" },
  { key: "cases", label: "Cases", note: "future task + fail signals" },
  { key: "chat_only", label: "Chat-only", note: "repo doesn’t answer it" },
  { key: "validated", label: "Validated", note: "pi fails w/o, passes with evidence" },
  { key: "approved", label: "Approved", note: "human review" },
];

type Tab = "validated" | "approved" | "rejected" | "all";

export default function Review({ repo }: { repo: string }) {
  const funnel = useAsync(() => getFunnel(repo), [repo]);
  const res = useAsync(() => getCases(repo), [repo]);
  const [tab, setTab] = useState<Tab>("validated");

  const update = (c: CaseDoc) =>
    res.setData((d: CasesResponse | undefined) => (d ? { ...d, cases: d.cases.map((x) => (x._id === c._id ? c : x)) } : d));

  const cases = (res.data?.cases ?? []).filter((c) => c.status !== "filtered_out" && c.status !== "generated");
  const shown = cases.filter((c) => tab === "all" || c.status === tab);
  const count = (t: Tab) => (t === "all" ? cases.length : cases.filter((c) => c.status === t).length);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>From chat history to eval cases</h1>
          <p className="lede">Every stage throws most things away. Only knowledge that lives in chat, not in the repo, becomes a case.</p>
        </div>
      </div>
      <FixtureNote data={[funnel.data, res.data]} />
      {funnel.error ? (
        <ErrorBox error={funnel.error} retry={funnel.reload} />
      ) : funnel.data ? (
        <FunnelStrip f={funnel.data} />
      ) : (
        <Loading what="funnel" />
      )}

      {!(res.data && !res.data.cases.length) && (
        <div className="tabs">
          {(
            [
              ["validated", "Needs review"],
              ["approved", "Approved"],
              ["rejected", "Rejected"],
              ["all", "All"],
            ] as [Tab, string][]
          ).map(([k, l]) => (
            <button key={k} type="button" className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
              {l} <span className="count">{count(k)}</span>
            </button>
          ))}
        </div>
      )}
      {res.error && <ErrorBox error={res.error} retry={res.reload} />}
      {!res.data && !res.error && <Loading what="cases" />}
      <div className="cards">
        {shown.map((c) => (
          <ReviewCard key={c._id} c={c} moment={res.data?.moments?.[c.moment_id]} onUpdate={update} />
        ))}
      </div>
      {res.data && !res.data.cases.length ? (
        <div className="empty empty-card">
          <strong>No cases yet.</strong>
          <span>
            Generation runs after mining. You can review the mined moments now in <a href={href("/moments")}>Moments</a>.
          </span>
        </div>
      ) : (
        res.data && !shown.length && <div className="empty">Nothing here. {tab === "validated" ? "Review queue is clear." : ""}</div>
      )}
    </div>
  );
}

function FunnelStrip({ f }: { f: Funnel }) {
  return (
    <div className="funnel" role="list">
      {STAGES.map((s, i) => {
        const v = f[s.key];
        const prev = i > 0 ? f[STAGES[i - 1].key] : undefined;
        const kept = prev ? v / prev : undefined; // prev 0/undefined → no ratio
        return (
          <div key={s.key} className={`funnel-stage${s.key === "durable_moments" ? " funnel-stage-link" : ""}`} role="listitem">
            {kept !== undefined && (
              <div className="funnel-kept" title={`${(kept * 100).toFixed(1)}% of previous stage kept`}>
                {kept === 0 ? 0 : kept < 0.1 ? (kept * 100).toFixed(1) : Math.round(kept * 100)}% kept
              </div>
            )}
            <div className="funnel-count">{v.toLocaleString("en-US")}</div>
            <div className="funnel-label">
              {s.key === "durable_moments" ? (
                <a href={href("/moments")} title="Browse the mined moments">
                  {s.label} →
                </a>
              ) : (
                s.label
              )}
            </div>
            <div className="funnel-note">{s.note}</div>
          </div>
        );
      })}
    </div>
  );
}

function ReviewCard({
  c,
  moment,
  onUpdate,
}: {
  c: CaseDoc;
  moment?: NonNullable<CasesResponse["moments"]>[string];
  onUpdate: (c: CaseDoc) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [editing, setEditing] = useState(!c.review);

  const submit = (verdict: "approve" | "reject") => {
    setBusy(true);
    setErr(undefined);
    postReview(c, verdict, reason.trim()).then(
      (updated) => {
        onUpdate(updated);
        setBusy(false);
        setEditing(false);
        setReason("");
      },
      (e) => {
        setErr(String(e?.message ?? e));
        setBusy(false);
      },
    );
  };

  return (
    <article className={`card card-${c.status}`}>
      <header className="card-head">
        <ScenarioTag s={c.scenario} />
        <StatusTag s={c.status} />
        {c.repeated_in_real_life && <span className="flag flag-accent">repeated in real life</span>}
        {c.chat_only === true && <span className="flag">chat-only</span>}
        <a className="card-link" href={caseHref(c._id)}>
          Inspect →
        </a>
      </header>
      <h3 className="card-task">{c.task}</h3>
      {moment && (
        <div className="card-row">
          <span className="card-k">From chat</span>
          <span className="card-moment">
            <RichText text={moment.text} /> <span className="muted small">· {fmtShortDate(moment.ts)}</span>
          </span>
        </div>
      )}
      <div className="card-row">
        <span className="card-k">Expected</span>
        <span>
          <RichText text={c.expected} />
        </span>
      </div>
      <div className="card-row">
        <span className="card-k">Fail if</span>
        <span className="chips">
          {c.fail_signals.map((f) => (
            <code key={f} className="chip-fail">
              {f}
            </code>
          ))}
        </span>
      </div>
      {c.validation && (
        <div className="card-row">
          <span className="card-k">Validation</span>
          <span className="validation-inline">
            {Object.entries(c.validation).map(([cfg, vs]) => (
              <span key={cfg}>
                <span className="mono">{cfg}</span>{" "}
                {vs.map((v, i) => (
                  <VerdictChip key={i} v={v} />
                ))}
              </span>
            ))}
          </span>
        </div>
      )}
      <footer className="card-foot">
        {c.review && !editing ? (
          <div className="card-review">
            <span className={`tag ${c.review.verdict === "approve" ? "status-approved" : "status-rejected"}`}>{c.review.verdict}d</span>
            <span>{c.review.reason || <span className="muted">no reason given</span>}</span>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setEditing(true)}>
              Change
            </button>
          </div>
        ) : (
          <div className="card-actions">
            <input
              type="text"
              placeholder="Reason (optional for approve)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-label="Review reason"
            />
            <button type="button" className="btn btn-approve" disabled={busy} onClick={() => submit("approve")}>
              ✓ Approve
            </button>
            <button
              type="button"
              className="btn btn-reject"
              disabled={busy || !reason.trim()}
              title={!reason.trim() ? "Give a reason to reject" : undefined}
              onClick={() => submit("reject")}
            >
              ✕ Reject
            </button>
          </div>
        )}
        {err && <div className="errorbox small">{err}</div>}
      </footer>
    </article>
  );
}
