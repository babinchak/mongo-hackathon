// Typed API client. Every call hits the real backend (/api, proxied to 127.0.0.1:8000 in dev) and
// falls back to bundled fixtures when the API is unreachable / not implemented, or when the URL
// contains `?fixtures` (either before the hash or inside it: `#/cases?fixtures`).
import type {
  CaseDetail,
  CaseDoc,
  CaseStatus,
  CasesResponse,
  CaseWithSummary,
  Funnel,
  HarnessConfig,
  LeaderboardRow,
  MomentDoc,
  RunDoc,
  SessionDoc,
  TimelineResponse,
  TurnDoc,
} from "./types";

// ------------------------------------------------------------------ API status + per-response provenance
/**
 * Header badge state. "live": the backend answered the last request (whatever the status code).
 * "offline": the backend couldn't be reached. "forced": `?fixtures` in the URL. "unknown": nothing sent yet.
 */
export type ApiStatus = "unknown" | "live" | "offline" | "forced";
let status: ApiStatus = fixturesForced() ? "forced" : "unknown";
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

/** GET /api/leaderboard?repo_id= */
export function getLeaderboard(repoId: string): Promise<LeaderboardRow[]> {
  return withFallback(
    () => http<LeaderboardRow[]>("GET", `/api/leaderboard${q({ repo_id: repoId })}`),
    async () => (await fixtures()).leaderboard,
  );
}

/** GET /api/funnel?repo_id= */
export function getFunnel(repoId: string): Promise<Funnel> {
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
  return withFallback(
    () => http<HarnessConfig[]>("GET", "/api/configs"),
    async () => (await fixtures()).configs,
  );
}

/** GET /api/timeline?repo_id= → {sessions, moments (durable, + has_case)} */
export function getTimeline(repoId: string): Promise<TimelineResponse> {
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
