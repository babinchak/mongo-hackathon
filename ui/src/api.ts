// Typed API client. Every call hits the real backend (/api, proxied to 127.0.0.1:8000 in dev) and
// falls back to bundled fixtures when the API is unreachable / not implemented, or when the URL
// contains `?fixtures` (either before the hash or inside it: `#/cases?fixtures`).
// Static builds (VITE_STATIC=1, `npm run build:static`) instead read pre-exported JSON from
// `<base>/data/` and never touch /api or the fixtures.
import type {
  CaseDetail,
  CaseDoc,
  CaseStatus,
  CasesResponse,
  CaseWithSummary,
  Funnel,
  HarnessConfig,
  HeldOut,
  JudgeAudit,
  LeaderboardRow,
  MemoryItem,
  MomentDoc,
  RunDoc,
  RunListItem,
  RunTrace,
  SessionDoc,
  Spend,
  TimelineResponse,
  TuningRun,
  TurnDoc,
} from "./types";

// ------------------------------------------------------------------ static snapshot mode
/** True in the read-only static build: every getter reads `data/*.json`, writes are refused. */
export const STATIC = import.meta.env.VITE_STATIC === "1";

/** Repo id to snapshot file slug: "FSM1/cipher-box" becomes "FSM1__cipher-box". */
const repoSlug = (repoId: string) => repoId.replace(/\//g, "__");
/** Case id to snapshot file name (anything but letters, digits and "-" becomes "_"). */
const caseFile = (id: string) => id.replace(/[^A-Za-z0-9-]/g, "_");

class NotInSnapshot extends Error {}

async function snap<T>(path: string): Promise<T> {
  const url = `${import.meta.env.BASE_URL}data/${path}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`couldn't fetch ${url}: ${String(e)}`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new NotInSnapshot(res.status === 404 ? `not in this snapshot (data/${path})` : `${res.status} data/${path}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    // Some static hosts answer a missing file with an HTML page.
    throw new NotInSnapshot(`not in this snapshot (data/${path})`);
  }
}

/** Snapshot file for an optional page extra: undefined when it's missing. */
async function snapOptional<T>(path: string): Promise<T | undefined> {
  try {
    return await snap<T>(path);
  } catch {
    return undefined;
  }
}

export interface SnapshotMeta {
  exported_at?: string;
  repos?: string[];
}
let metaP: Promise<SnapshotMeta | undefined> | null = null;
/** data/meta.json (static mode only). */
export function getSnapshotMeta(): Promise<SnapshotMeta | undefined> {
  if (!STATIC) return Promise.resolve(undefined);
  return (metaP ??= snapOptional<SnapshotMeta>("meta.json"));
}

const READ_ONLY = "This hosted page is a read-only snapshot.";

// ------------------------------------------------------------------ API status + per-response provenance
/**
 * Header badge state. "live": the backend answered the last request (whatever the status code).
 * "offline": the backend couldn't be reached. "forced": `?fixtures` in the URL. "unknown": nothing sent yet.
 */
export type ApiStatus = "unknown" | "live" | "offline" | "forced" | "snapshot";
let status: ApiStatus = STATIC ? "snapshot" : fixturesForced() ? "forced" : "unknown";
const listeners = new Set<(s: ApiStatus) => void>();
export function getApiStatus(): ApiStatus {
  return status;
}
export function onApiStatusChange(fn: (s: ApiStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function setStatus(s: ApiStatus) {
  if (status === s || status === "forced") return;
  status = s;
  listeners.forEach((fn) => fn(s));
}

/** Responses that came from bundled fixtures rather than the API, with the reason. */
const FIXTURE = new WeakMap<object, string>();
/** Why this response is fixture data, or undefined if it came from the live API. */
export function fixtureReason(data: unknown): string | undefined {
  return typeof data === "object" && data !== null ? FIXTURE.get(data) : undefined;
}

export function fixturesForced(): boolean {
  if (typeof window === "undefined") return false;
  const inSearch = new URLSearchParams(window.location.search).has("fixtures");
  const q = window.location.hash.split("?")[1] ?? "";
  return inSearch || new URLSearchParams(q).has("fixtures");
}

/** The backend is unreachable, or this route isn't built yet. Only these fall back to fixtures. */
class Unavailable extends Error {
  constructor(
    message: string,
    readonly reason: "offline" | "not_built",
  ) {
    super(message);
  }
}

async function http<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 15000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    setStatus("offline");
    throw new Unavailable(String(e), "offline");
  }
  clearTimeout(timer);
  const text = await res.text().catch(() => "");
  // Vite's proxy answers 502/503/504 (or a bodiless 500) when the backend is down.
  if ([502, 503, 504].includes(res.status) || (res.status === 500 && !text.trim())) {
    setStatus("offline");
    throw new Unavailable(`${res.status} ${text.slice(0, 200)}`, "offline");
  }
  setStatus("live");
  // A bare FastAPI 404 "Not Found" / 405 / 501 means the route isn't built yet.
  if ([405, 501].includes(res.status) || (res.status === 404 && (!text || /"detail"\s*:\s*"Not Found"/.test(text)))) {
    throw new Unavailable(`${res.status} ${path}`, "not_built");
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${method} ${path}: response is not JSON`);
  }
}

async function withFallback<T>(live: () => Promise<T>, fixture: () => Promise<T>): Promise<T> {
  const mark = (out: T, why: string) => {
    if (typeof out === "object" && out !== null) FIXTURE.set(out as object, why);
    return out;
  };
  if (fixturesForced()) return mark(await fixture(), "fixtures forced by ?fixtures in the URL");
  try {
    // A live 200 is always the answer, even when it's empty: callers show real empty states.
    return await live();
  } catch (e) {
    if (!(e instanceof Unavailable)) throw e;
    console.warn("[hindsight] API unavailable, using fixtures:", e.message);
    return mark(await fixture(), e.reason === "offline" ? "API offline" : "this endpoint isn’t built yet");
  }
}

// ------------------------------------------------------------------ fixtures (lazy-loaded)
interface FixtureDB {
  configs: HarnessConfig[];
  cases: CaseDoc[];
  moments: MomentDoc[];
  turns: TurnDoc[];
  runs: RunDoc[];
  sessions: SessionDoc[];
  leaderboard: LeaderboardRow[];
  funnel: Funnel;
}
let fx: Promise<FixtureDB> | null = null;
function fixtures(): Promise<FixtureDB> {
  if (!fx) {
    fx = Promise.all([
      import("./fixtures/configs.json"),
      import("./fixtures/cases.json"),
      import("./fixtures/moments.json"),
      import("./fixtures/turns.json"),
      import("./fixtures/runs.json"),
      import("./fixtures/sessions.json"),
      import("./fixtures/leaderboard.json"),
      import("./fixtures/funnel.json"),
    ]).then(([configs, cases, moments, turns, runs, sessions, leaderboard, funnel]) => ({
      // structuredClone so in-session edits (reviews, simulated runs) don't touch module JSON
      configs: structuredClone(configs.default) as HarnessConfig[],
      cases: structuredClone(cases.default) as CaseDoc[],
      moments: structuredClone(moments.default) as MomentDoc[],
      turns: structuredClone(turns.default) as TurnDoc[],
      runs: structuredClone(runs.default) as RunDoc[],
      sessions: structuredClone(sessions.default) as SessionDoc[],
      leaderboard: structuredClone(leaderboard.default) as LeaderboardRow[],
      funnel: structuredClone(funnel.default) as Funnel,
    }));
  }
  return fx;
}

function fxSummary(db: FixtureDB): CasesResponse["summary"] {
  const out: CasesResponse["summary"] = {};
  for (const r of db.runs) {
    const c = (out[r.case_id] ??= {});
    const s = (c[r.config_id] ??= { pass: 0, n: 0 });
    const n = s.n ?? 0;
    s.pass = (s.pass * n + (r.verdict === "pass" ? 1 : 0)) / (n + 1);
    s.n = n + 1;
  }
  return out;
}

// ------------------------------------------------------------------ endpoints
const q = (params: Record<string, string | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : "";
};

/** GET /api/leaderboard?repo_id= (all repos when repoId is undefined) */
export function getLeaderboard(repoId: string | undefined): Promise<LeaderboardRow[]> {
  if (STATIC) return snap(repoId ? `leaderboard/${repoSlug(repoId)}.json` : "leaderboard.json");
  return withFallback(
    () => http<LeaderboardRow[]>("GET", `/api/leaderboard${q({ repo_id: repoId })}`),
    async () => (await fixtures()).leaderboard,
  );
}

/** GET /api/funnel?repo_id= (all repos when repoId is undefined) */
export function getFunnel(repoId?: string): Promise<Funnel> {
  if (STATIC) return snap(repoId ? `funnel/${repoSlug(repoId)}.json` : "funnel.json");
  return withFallback(
    () => http<Funnel>("GET", `/api/funnel${q({ repo_id: repoId })}`),
    async () => (await fixtures()).funnel,
  );
}

/** Accepts either `{cases, summary}` or an array of case docs with `summary: {config_id: rate}`. */
function normalizeCases(raw: CasesResponse | CaseWithSummary[]): CasesResponse {
  if (!Array.isArray(raw)) return raw;
  const summary: CasesResponse["summary"] = {};
  const cases: CaseDoc[] = raw.map(({ summary: s, ...c }) => {
    summary[c._id] = Object.fromEntries(Object.entries(s ?? {}).map(([cfg, v]) => [cfg, typeof v === "number" ? { pass: v, n: null } : v]));
    return c as CaseDoc;
  });
  return { cases, summary };
}

/** GET /api/cases?repo_id=&status= */
export function getCases(repoId: string, status?: CaseStatus): Promise<CasesResponse> {
  if (STATIC)
    return snap<CasesResponse | CaseWithSummary[]>(`cases/${repoSlug(repoId)}.json`).then((raw) => {
      const all = normalizeCases(raw);
      return status ? { ...all, cases: all.cases.filter((c) => c.status === status) } : all;
    });
  return withFallback(
    async () => normalizeCases(await http<CasesResponse | CaseWithSummary[]>("GET", `/api/cases${q({ repo_id: repoId, status })}`)),
    async () => {
      const db = await fixtures();
      const cases = db.cases.filter((c) => c.repo_id === repoId && (!status || c.status === status));
      const ids = new Set(cases.map((c) => c.moment_id));
      const moments = Object.fromEntries(
        db.moments.filter((m) => ids.has(m._id)).map((m) => [m._id, { text: m.text, ts: m.ts, moment_kind: m.moment_kind }]),
      );
      return { cases, summary: fxSummary(db), moments };
    },
  );
}

/** GET /api/cases/:id */
export function getCase(id: string): Promise<CaseDetail> {
  if (STATIC) return snap(`case/${caseFile(id)}.json`);
  return withFallback(
    () => http<CaseDetail>("GET", `/api/cases/${encodeURIComponent(id)}`),
    async () => {
      const db = await fixtures();
      const c = db.cases.find((x) => x._id === id);
      if (!c) throw new Error(`case ${id} not found in fixtures`);
      const moment = db.moments.find((m) => m._id === c.moment_id)!;
      const src = db.turns.find((t) => t._id === moment.source_turn_id);
      const source_turns = src
        ? db.turns.filter((t) => t.session_id === src.session_id && Math.abs(t.seq - src.seq) <= 6).sort((a, b) => a.seq - b.seq)
        : [];
      const relIds = new Set([...moment.supersedes, ...moment.superseded_by, ...moment.repeats, ...moment.repeated_by]);
      return {
        case: c,
        moment,
        source_turns,
        runs: db.runs.filter((r) => r.case_id === id),
        related_moments: db.moments.filter((m) => relIds.has(m._id)),
      };
    },
  );
}

/** POST /api/cases/:id/review {verdict, reason} → {ok, status} (or the updated case doc). Returns the updated case. */
export function postReview(c: CaseDoc, verdict: "approve" | "reject", reason: string): Promise<CaseDoc> {
  const updated: CaseDoc = { ...c, review: { verdict, reason }, status: verdict === "approve" ? "approved" : "rejected" };
  if (STATIC) return Promise.reject(new Error(READ_ONLY));
  return withFallback(
    async () => {
      const res = await http<Partial<CaseDoc> & { ok?: boolean; status?: string }>(
        "POST",
        `/api/cases/${encodeURIComponent(c._id)}/review`,
        { verdict, reason },
      );
      return res && "_id" in res ? (res as CaseDoc) : { ...updated, status: (res?.status as CaseDoc["status"]) ?? updated.status };
    },
    async () => {
      const db = await fixtures();
      const i = db.cases.findIndex((x) => x._id === c._id);
      if (i >= 0) db.cases[i] = structuredClone(updated);
      return updated;
    },
  );
}

/** GET /api/configs */
export function getConfigs(): Promise<HarnessConfig[]> {
  if (STATIC) return snap("configs.json");
  return withFallback(
    () => http<HarnessConfig[]>("GET", "/api/configs"),
    async () => (await fixtures()).configs,
  );
}

/** GET /api/timeline?repo_id= → {sessions, moments (durable, + has_case)} */
export function getTimeline(repoId: string): Promise<TimelineResponse> {
  if (STATIC) return snap(`timeline/${repoSlug(repoId)}.json`);
  return withFallback(
    () => http<TimelineResponse>("GET", `/api/timeline${q({ repo_id: repoId })}`),
    async () => {
      const db = await fixtures();
      const withCase = new Set(db.cases.map((c) => c.moment_id));
      return {
        sessions: db.sessions.filter((s) => s.repo_id === repoId),
        moments: db.moments.filter((m) => m.repo_id === repoId && m.durable).map((m) => ({ ...m, has_case: withCase.has(m._id) })),
      };
    },
  );
}

/**
 * GET /api/moments?repo_id=&durable=&limit= → moment docs (+ source_text), sorted by ts.
 * The page filters kind / search / relations client-side so chip counts stay exact.
 */
export function getMoments(repoId: string, durable: boolean, limit = 5000): Promise<MomentDoc[]> {
  // The snapshot drops source_text and raw_text: only the mined rule is published.
  if (STATIC) return snap(`moments/${repoSlug(repoId)}${durable ? "" : ".rejected"}.json`);
  return withFallback(
    () => http<MomentDoc[]>("GET", `/api/moments${q({ repo_id: repoId, durable: String(durable), limit: String(limit) })}`),
    async () => {
      const db = await fixtures();
      const turns = new Map(db.turns.map((t) => [t._id, t.text]));
      return db.moments
        .filter((m) => m.repo_id === repoId && m.durable === durable)
        .map((m) => ({ ...m, source_text: turns.get(m.source_turn_id)?.slice(0, 2000) ?? "" }));
    },
  );
}

/** POST /api/runs {case_id, config_id, horizon_days} → run doc. Blocks ~30 s while pi runs. */
export function postRun(case_id: string, config_id: string, horizon_days: number): Promise<RunDoc> {
  if (STATIC) return Promise.reject(new Error(READ_ONLY));
  return withFallback(
    () => http<RunDoc>("POST", "/api/runs", { case_id, config_id, horizon_days }, 300_000),
    async () => {
      // Simulated: replay a recorded run for the same case/config/horizon after a short delay.
      const db = await fixtures();
      const pool = db.runs.filter((r) => r.case_id === case_id && r.config_id === config_id && r.horizon_days === horizon_days);
      await new Promise((r) => setTimeout(r, 3500 + Math.random() * 2500));
      const base = pool[Math.floor(Math.random() * pool.length)] ?? db.runs.find((r) => r.case_id === case_id)!;
      const run: RunDoc = {
        ...structuredClone(base),
        _id: `sim-${Math.random().toString(16).slice(2, 10)}`,
        repeat: pool.length,
        created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      };
      db.runs.push(run);
      return run;
    },
  );
}

/** GET /api/tuning → self-tuning runs, newest first. */
export function getTuning(): Promise<TuningRun[]> {
  if (STATIC) return snap("tuning.json");
  return withFallback(
    () => http<TuningRun[]>("GET", "/api/tuning"),
    async () => structuredClone((await import("./fixtures/tuning.json")).default) as TuningRun[],
  );
}

/** Runs lists per config, shared by the explorer and the trace view (prev / next). */
const runsCache = new Map<string, Promise<RunListItem[]>>();

/**
 * GET /api/runs?config_id= → every run of one config (all repos, no response / tool_calls).
 * Filters (repo, verdict, horizon) are applied client-side so counts stay exact in every mode.
 * `fresh` refetches instead of reusing the cached list.
 */
export function getRuns(configId: string, { fresh = false } = {}): Promise<RunListItem[]> {
  const hit = runsCache.get(configId);
  if (hit && !fresh) return hit;
  const p = STATIC
    ? snap<RunListItem[]>(`runs/${caseFile(configId)}.json`)
    : withFallback(
        () => http<RunListItem[]>("GET", `/api/runs${q({ config_id: configId })}`),
        async () => {
          const db = await fixtures();
          const cases = new Map(db.cases.map((c) => [c._id, c]));
          return db.runs
            .filter((r) => r.config_id === configId)
            .map(({ response: _r, tool_calls: _t, ...r }) => {
              const c = cases.get(r.case_id);
              return { ...r, task: c?.task ?? "", repo_id: c?.repo_id ?? "", scenario: c?.scenario ?? "durable_constraint", n_context: r.context_ids.length };
            });
        },
      );
  runsCache.set(configId, p);
  p.catch(() => runsCache.delete(configId));
  return p;
}

/** GET /api/runs/:id → the run (with response + tool_calls), its case, config, and the memory pi saw. */
export function getRun(id: string): Promise<RunTrace> {
  if (STATIC) return snap(`run/${caseFile(id)}.json`);
  return withFallback(
    () => http<RunTrace>("GET", `/api/runs/${encodeURIComponent(id)}`),
    async () => {
      const db = await fixtures();
      const run = db.runs.find((r) => r._id === id);
      if (!run) throw new Error(`run ${id} not found in fixtures`);
      const c = db.cases.find((x) => x._id === run.case_id);
      if (!c) throw new Error(`case ${run.case_id} not found in fixtures`);
      const gold = new Set(c.gold_evidence);
      const moments = new Map(db.moments.map((m) => [m._id, m]));
      const turns = new Map(db.turns.map((t) => [t._id, t]));
      const memory: MemoryItem[] = run.context_ids.flatMap((cid): MemoryItem[] => {
        const m = moments.get(cid);
        if (m) return [{ id: cid, kind: "moment", ts: m.ts, text: m.text, moment_kind: m.moment_kind, topic: m.topic, is_gold: gold.has(cid) }];
        const t = turns.get(cid);
        if (t) return [{ id: cid, kind: "turn", ts: t.ts, text: t.text, role: t.role, is_gold: gold.has(cid) }];
        return [];
      });
      return { run, case: c, config: db.configs.find((x) => x._id === run.config_id) ?? null, memory };
    },
  );
}

/** Live-only extras for page footers: undefined when forced to fixtures, offline, or not built. */
async function optional<T>(path: string): Promise<T | undefined> {
  if (fixturesForced()) return undefined;
  try {
    return await http<T>("GET", path);
  } catch {
    return undefined;
  }
}

/** GET /api/judge_audit → {} until the audit has run. */
export const getJudgeAudit = () => (STATIC ? snapOptional<JudgeAudit>("judge_audit.json") : optional<JudgeAudit>("/api/judge_audit"));

/** GET /api/heldout → the headline held-out comparison; undefined when missing or not built yet. */
export const getHeldout = () => (STATIC ? snapOptional<HeldOut>("heldout.json") : optional<HeldOut>("/api/heldout"));

/** GET /api/heldout?all=true: every hand-designed config plus the tuned one, on the held-out cases only. */
export const getHeldoutAll = () =>
  STATIC ? snapOptional<HeldOut>("heldout_all.json") : optional<HeldOut>("/api/heldout?all=true");

/** GET /api/spend */
export const getSpend = () => (STATIC ? snapOptional<Spend>("spend.json") : optional<Spend>("/api/spend"));
