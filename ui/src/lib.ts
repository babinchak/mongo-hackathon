import { useCallback, useEffect, useMemo, useState } from "react";
import type { HarnessConfig, MomentKind, RunListItem, Scenario, ToolCall } from "./types";

// ------------------------------------------------------------------ routing (hash-based)
export type Route =
  | { name: "overview" }
  | { name: "leaderboard" }
  | { name: "evolution" }
  | { name: "cases" }
  | { name: "case"; id: string }
  | { name: "moments" }
  | { name: "review" }
  | { name: "timeline" }
  | { name: "runs" }
  | { name: "run"; id: string };

export function parseHash(hash: string): Route {
  const path = hashPath(hash);
  const parts = path.split("/").filter(Boolean);
  switch (parts[0]) {
    case "cases":
      return parts[1] ? { name: "case", id: decodeURIComponent(parts.slice(1).join("/")) } : { name: "cases" };
    case "moments":
      return { name: "moments" };
    case "review":
      return { name: "review" };
    case "timeline":
      return { name: "timeline" };
    case "evolution":
      return { name: "evolution" };
    case "leaderboard":
      return { name: "leaderboard" };
    case "runs":
      return { name: "runs" };
    case "run":
      return parts[1] ? { name: "run", id: decodeURIComponent(parts.slice(1).join("/")) } : { name: "runs" };
    default:
      return { name: "overview" };
  }
}

const hashPath = (hash: string) => hash.replace(/^#/, "").split("?")[0];
export const hashQuery = (hash = window.location.hash) => new URLSearchParams(hash.split("?")[1] ?? "");

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    let path = hashPath(window.location.hash);
    const on = () => {
      const next = hashPath(window.location.hash);
      setRoute(parseHash(window.location.hash));
      // Only reset scroll on a real page change, not when a page tweaks its own query (?id=, ?repo=).
      if (next !== path) window.scrollTo(0, 0);
      path = next;
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

/** The current hash query, re-read on every hash change. */
export function useHashQuery(): URLSearchParams {
  const [qs, setQs] = useState(() => window.location.hash.split("?")[1] ?? "");
  useEffect(() => {
    const on = () => setQs(window.location.hash.split("?")[1] ?? "");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return useMemo(() => new URLSearchParams(qs), [qs]);
}

/** Query keys that follow you from page to page. */
const STICKY = ["repo", "fixtures"];

/** Build a hash href. Keeps the sticky query (`repo`, `fixtures`) and adds `params`. */
export function href(path: string, params?: Record<string, string | undefined>): string {
  const cur = hashQuery();
  const out = new URLSearchParams();
  for (const k of STICKY) if (cur.has(k)) out.set(k, cur.get(k)!);
  for (const [k, v] of Object.entries(params ?? {})) if (v != null) out.set(k, v);
  const s = out.toString().replace(/(^|&)fixtures=(?=&|$)/, "$1fixtures");
  return `#${path}${s ? `?${s}` : ""}`;
}
export const caseHref = (id: string) => href(`/cases/${encodeURIComponent(id)}`);
/** Run explorer for one config (`extra` carries list filters such as verdict / h / unused). */
export const runsHref = (configId: string, extra?: Record<string, string | undefined>) => href("/runs", { config: configId, ...extra });
/** Trace of one run; `extra` carries the list filters so prev / next walk the same list. */
export const runHref = (id: string, extra?: Record<string, string | undefined>) => href(`/run/${encodeURIComponent(id)}`, extra);
export const momentHref = (id: string, repo?: string) => href("/moments", { id, repo });

/** Change query keys on the current hash (undefined deletes). `replace` avoids a history entry. */
export function setHashQuery(updates: Record<string, string | undefined>, { replace = false } = {}) {
  const [path] = window.location.hash.replace(/^#/, "").split("?");
  const cur = hashQuery();
  for (const [k, v] of Object.entries(updates)) {
    if (v == null || v === "") cur.delete(k);
    else cur.set(k, v);
  }
  const s = cur.toString().replace(/(^|&)fixtures=(?=&|$)/, "$1fixtures");
  const next = `#${path || "/"}${s ? `?${s}` : ""}`;
  if (next === window.location.hash) return;
  if (replace) {
    history.replaceState(history.state, "", next);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = next;
  }
}

// ------------------------------------------------------------------ repo selection
export const REPOS = ["FSM1/cipher-box", "marcus-sa/brain", "melagiri/code-insights"] as const;
export const DEFAULT_REPO = REPOS[0];
/** Switcher value meaning "every repo" (leaderboard + evolution only; other pages need one repo). */
export const ALL_REPOS = "all";
const REPO_KEY = "hindsight.repo";
const CONCRETE_KEY = "hindsight.repo.concrete";

function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** A single repo for pages that need one: the selection, or the last single repo picked when "All repos" is on. */
export function concreteRepo(repo: string): string {
  return repo !== ALL_REPOS ? repo : stored(CONCRETE_KEY) || DEFAULT_REPO;
}

function storedRepo(): string | null {
  try {
    return window.localStorage.getItem(REPO_KEY);
  } catch {
    return null;
  }
}

/** Selected repo: `?repo=` in the hash, else the last one picked (localStorage), else the default. */
export function currentRepo(): string {
  return hashQuery().get("repo") || storedRepo() || DEFAULT_REPO;
}

export function useRepo(): string {
  const q = useHashQuery();
  return q.get("repo") || storedRepo() || DEFAULT_REPO;
}

export function setRepo(repo: string) {
  try {
    window.localStorage.setItem(REPO_KEY, repo);
    if (repo !== ALL_REPOS) window.localStorage.setItem(CONCRETE_KEY, repo);
  } catch {
    /* private mode / blocked storage: the URL still carries it */
  }
  // A moment id belongs to one repo; drop it when switching.
  setHashQuery({ repo, id: undefined });
}

// ------------------------------------------------------------------ async
export interface Async<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
  setData: (fn: (d: T | undefined) => T | undefined) => void;
}
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Async<T> {
  const [data, setDataState] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(undefined);
    fn().then(
      (d) => alive && (setDataState(d), setLoading(false)),
      (e) => alive && (setError(String(e?.message ?? e)), setLoading(false)),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const setData = useCallback((f: (d: T | undefined) => T | undefined) => setDataState((d) => f(d)), []);
  return { data, error, loading, reload, setData };
}

// ------------------------------------------------------------------ formatting
export const pct = (x: number | null | undefined, digits = 0) => (x == null || Number.isNaN(x) ? "-" : `${(x * 100).toFixed(digits)}%`);
export const pts = (d: number) => `${d >= 0 ? "+" : "−"}${Math.abs(Math.round(d * 100))}`;
export const usd = (x: number | null | undefined) => (x == null ? "-" : `$${x.toFixed(x < 0.1 ? 3 : 2)}`);
/** Parse an ISO string; timestamps without a zone (Mongo naive datetimes) are treated as UTC. */
export const parseDate = (s: string | number | null | undefined): Date =>
  typeof s === "string" && /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? new Date(`${s}Z`) : new Date(s ?? NaN);
export const isFar = (s: string | null | undefined) => !s || s.startsWith("9999");
export const fmtDate = (s: string) =>
  parseDate(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export const fmtShortDate = (s: string) => parseDate(s).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
export const fmtTime = (s: string) =>
  parseDate(s).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
export const fmtDuration = (s: number | null | undefined) =>
  s == null ? "-" : s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s.toFixed(0)}s`;

export const SCENARIO_LABEL: Record<Scenario, string> = {
  durable_constraint: "Durable constraint",
  superseded_decision: "Superseded decision",
  failed_approach: "Failed approach",
};
export const SCENARIOS: Scenario[] = ["durable_constraint", "superseded_decision", "failed_approach"];

export const KIND_LABEL: Record<MomentKind, string> = {
  constraint: "Constraint",
  decision: "Decision",
  fact: "Fact",
  procedure: "Procedure",
  failed_approach: "Failed approach",
  none: "Untyped",
};

/** Tool paths inside the checked-out snapshot, shown relative to the repo root. */
export const relPath = (p: string) => p.replace(/^.*?\/hindsight-snapshots\/[^/]+\/[^/]+\/?/, "") || ".";

export function toolSummary(c: ToolCall): string {
  const a = c.args ?? {};
  const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
  const n = (k: string) => (typeof a[k] === "number" ? (a[k] as number) : undefined);
  const path = s("path") ?? s("file_path");
  switch (c.tool) {
    case "search_memory":
      return `“${s("query") ?? JSON.stringify(a)}”`;
    case "read": {
      if (!path) return JSON.stringify(a);
      const off = n("offset");
      const lim = n("limit");
      return off && off > 1 ? `${relPath(path)}  :${off}${lim ? `-${off + lim - 1}` : ""}` : relPath(path);
    }
    case "ls":
      return path ? relPath(path) : ".";
    case "grep":
    case "find": {
      const where = [path && path !== "." ? relPath(path) : undefined, s("glob")].filter(Boolean).join(" ");
      return [s("pattern"), where].filter(Boolean).join("  in ") || JSON.stringify(a);
    }
    case "bash":
      return s("command") ?? JSON.stringify(a);
    default:
      return JSON.stringify(a);
  }
}

/** "FSM1/cipher-box" → "cipher-box". */
export const repoShort = (id: string) => id.split("/").pop() ?? id;

/** Human-readable knob flags for a harness config (leaderboard rows, run explorer header). */
export function configFlags(c?: HarnessConfig | null): string[] {
  if (!c) return [];
  if (!c.memory) return ["no memory extension"];
  const f = [c.retrieval ?? "", c.source ?? ""];
  if (c.k) f.push(`k=${c.k}`);
  if (c.briefing) f.push(c.briefing_k ? `briefing ×${c.briefing_k}` : "briefing");
  f.push(c.drop_superseded ? "drop superseded" : "keeps superseded");
  if (c.recency_weight) f.push(`recency ${c.recency_weight}`);
  if (c.framing && c.framing !== "notes") f.push(`as ${c.framing}`);
  if (c.nudge && c.nudge !== "none") f.push(`nudge: ${c.nudge.replace("_", " ")}`);
  return f.filter(Boolean);
}

export const shortSha = (s: string | null | undefined) => (s ? s.slice(0, 7) : "-");

/** Compact column labels for known config ids; unknown ids fall back to the id. */
export const CONFIG_SHORT: Record<string, string> = {
  repo_only: "repo",
  vector_turns: "vec·turns",
  hybrid_turns: "hyb·turns",
  hybrid_all: "hyb·all",
  hybrid_all_brief: "hyb·brief",
  ablate_superseded: "ablate",
  oracle: "oracle",
};
export const isLive = (r: { phase?: string; repeat: number }) => r.phase === "live" || r.repeat < 0;

/** Configs written by the self-tuning harness. */
export const isTuned = (id: string) => id.startsWith("tuned_");
/** "tuned_20260926T101500_3" → "tuned #3"; other ids unchanged. */
export const configName = (id: string) => {
  const m = /^tuned_.*_(\d+)$/.exec(id);
  return m ? `tuned #${m[1]}` : id;
};

// ------------------------------------------------------------------ run lists (explorer + trace prev / next)
/** List filters carried in the hash query: verdict=pass|fail, unused=1, h=<days>, case=<id>; repo comes from the switcher. */
export interface RunFilter {
  repo?: string;
  verdict?: "pass" | "fail";
  /** Retrieved but not used: failed although memory returned the gold evidence. */
  unused?: boolean;
  h?: number;
  caseId?: string;
}

export function readRunFilter(q: URLSearchParams, repo: string | undefined): RunFilter {
  const v = q.get("verdict");
  const h = Number(q.get("h"));
  return {
    repo: repo && repo !== ALL_REPOS ? repo : undefined,
    verdict: v === "pass" || v === "fail" ? v : undefined,
    unused: q.get("unused") === "1",
    h: Number.isFinite(h) && h > 0 ? h : undefined,
    caseId: q.get("case") || undefined,
  };
}

/** The filter as hash params for links (repo is sticky on its own). */
export const runFilterParams = (f: RunFilter): Record<string, string | undefined> => ({
  verdict: f.verdict,
  unused: f.unused ? "1" : undefined,
  h: f.h ? String(f.h) : undefined,
  case: f.caseId,
});

export function applyRunFilter<T extends RunListItem>(runs: T[], f: RunFilter, skip: ("verdict" | "h")[] = []): T[] {
  return runs.filter(
    (r) =>
      (!f.repo || r.repo_id === f.repo) &&
      (!f.caseId || r.case_id === f.caseId) &&
      (skip.includes("h") || !f.h || r.horizon_days === f.h) &&
      (skip.includes("verdict") || ((!f.verdict || r.verdict === f.verdict) && (!f.unused || (r.verdict === "fail" && r.hit_gold)))),
  );
}

/** Stable order: repo, then case (so repeats sit together), horizon, repeat. */
export const sortRuns = <T extends RunListItem>(runs: T[]): T[] =>
  [...runs].sort(
    (a, b) =>
      a.repo_id.localeCompare(b.repo_id) ||
      a.case_id.localeCompare(b.case_id) ||
      a.horizon_days - b.horizon_days ||
      a.repeat - b.repeat ||
      String(a.created_at).localeCompare(String(b.created_at)),
  );

/** Distinctive terms from fail signals to highlight in a plan: backticked snippets and path-like tokens in them. */
export function failTerms(signals: string[]): string[] {
  const out = new Set<string>();
  for (const s of signals ?? []) {
    for (const m of s.matchAll(/`([^`]+)`/g)) {
      const t = m[1].trim();
      if (t.length >= 4) out.add(t);
      const last = t.split(/\s+/).pop() ?? "";
      if (last !== t && last.length >= 6 && /[/@.]/.test(last)) out.add(last);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}
