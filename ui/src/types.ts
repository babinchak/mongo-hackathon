// Document shapes mirrored from CONTRACTS.md (frozen). Timestamps are ISO-8601 strings over HTTP.

export type ISODate = string;

export type Scenario = "durable_constraint" | "superseded_decision" | "failed_approach";
export type CaseStatus = "generated" | "filtered_out" | "validated" | "rejected" | "approved";
export type Verdict = "pass" | "fail" | "error";
export type MomentKind = "constraint" | "decision" | "fact" | "procedure" | "failed_approach" | "none";
export type Pushback = "correction" | "failure_report" | "rejection" | "takeover" | null;

export interface SessionDoc {
  _id: string;
  repo_id: string;
  started_at: ISODate;
  agent: string;
  prompts: number;
  branch: string;
}

interface MemoryCommon {
  _id: string;
  repo_id: string;
  session_id: string;
  seq: number;
  ts: ISODate;
  text: string;
  durable: boolean;
  superseded_at: ISODate;
  embedding?: number[];
}

export interface TurnDoc extends MemoryCommon {
  kind: "turn";
  role: "user" | "assistant";
  pushback: Pushback;
  noise: boolean;
  /** Optional hint from the API: this turn is gold/moment evidence. The UI also derives it. */
  evidence?: boolean;
}

export interface MomentDoc extends MemoryCommon {
  kind: "moment";
  moment_kind: MomentKind;
  topic: string;
  confidence: number;
  source_turn_id: string;
  evidence: string[];
  repeats: string[];
  repeated_by: string[];
  supersedes: string[];
  superseded_by: string[];
  pushback?: Pushback;
  /** Set by the audit pass: `text` was rewritten from `raw_text`. */
  refined?: boolean;
  /** The miner's statement before the audit rewrote it (may be absent). */
  raw_text?: string;
  /** Why the audit rejected it (on durable: false moments). */
  refine_reason?: string;
  /** GET /api/moments: the developer's original words (source turn text, ≤2000 chars). */
  source_text?: string;
  /** GET /api/timeline: an eval case was generated from this moment. */
  has_case?: boolean;
}

export type MemoryDoc = TurnDoc | MomentDoc;

export interface Cutoff {
  horizon_days: number;
  cutoff: ISODate;
  session_id: string;
  commit: string | null;
}

export interface CaseDoc {
  _id: string;
  repo_id: string;
  moment_id: string;
  scenario: Scenario;
  task: string;
  expected: string;
  fail_signals: string[];
  keywords: string[];
  gold_evidence: string[];
  cutoffs: Cutoff[];
  repeated_in_real_life: boolean;
  chat_only: boolean | null;
  status: CaseStatus;
  validation?: Record<string, Verdict[]>;
  review?: { verdict: "approve" | "reject"; reason: string } | null;
}

export interface HarnessConfig {
  _id: string;
  label: string;
  memory: boolean;
  retrieval?: "vector" | "bm25" | "hybrid";
  source?: "turns" | "moments" | "moments+turns";
  k?: number;
  briefing?: boolean;
  drop_superseded?: boolean;
  recency_weight?: number;
  briefing_k?: number;
  framing?: "notes" | "rules" | string;
  nudge?: "none" | "search_first" | "restate" | string;
  /** Written by the self-tuning harness (config_id "tuned_…", label "Tuned #n"). */
  tuned?: boolean;
  hypothesis?: string;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface RunDoc {
  _id: string;
  case_id: string;
  config_id: string;
  repeat: number;
  horizon_days: number;
  cutoff: ISODate;
  commit: string | null;
  model: string | null;
  /** Backend field: "sweep" (leaderboard), "validation", or "live" (Run now, repeat = -1). */
  phase?: "sweep" | "validation" | "live" | string;
  tool_calls: ToolCall[];
  used_memory_tool: boolean;
  context_ids: string[];
  hit_gold: boolean;
  response: string;
  verdict: Verdict;
  reason: string;
  cost_usd: number;
  turns: number | null;
  duration_s: number | null;
  created_at: ISODate;
}

// ---- API response shapes (not collections) ----

export interface SliceStats {
  n_cases: number;
  n_runs?: number; // present on the top-level row; optional in by_scenario / by_horizon
  pass_at_1: number; // 0..1
  pass_pow_3: number; // 0..1
}

export interface LeaderboardRow extends SliceStats {
  n_runs: number;
  /** (case, cutoff) units scored. */
  n_units?: number;
  /** Repeats per unit behind pass_pow_3 (i.e. it is pass^k). */
  k?: number;
  config_id: string;
  label: string;
  evidence_recall: number | null; // 0..1 (UI shows "—" for configs with memory: false)
  memory_tool_use: number | null; // 0..1
  cost_usd_per_run: number;
  by_scenario: Record<string, SliceStats>; // key: Scenario
  by_horizon: Record<string, SliceStats>; // key: horizon_days as string, e.g. "7"
}

export interface Funnel {
  events: number;
  pushback: number;
  durable_moments: number;
  cases: number;
  chat_only: number;
  validated: number;
  approved: number;
}

/**
 * Normalized form of GET /api/cases. The backend may return either this object or a plain array of
 * case docs each carrying `summary: {config_id: pass_rate}`; api.ts normalizes both.
 */
export interface CasesResponse {
  cases: CaseDoc[];
  summary: Record<string, Record<string, { pass: number; n: number | null }>>;
  /** Optional: moment text/kind/date keyed by moment_id, shown on review cards. */
  moments?: Record<string, { text: string; ts: ISODate; moment_kind: MomentKind }>;
}

/** GET /api/cases (backend shape): case docs with a per-config pass-rate summary. */
export type CaseWithSummary = CaseDoc & { summary?: Record<string, number | { pass: number; n: number }> };

export interface CaseDetail {
  case: CaseDoc;
  moment: MomentDoc;
  source_turns: TurnDoc[];
  runs: RunDoc[];
  /** Optional: moments this one supersedes / is superseded by (for superseded_decision cases). */
  related_moments?: MomentDoc[];
}

export interface TimelineResponse {
  sessions: SessionDoc[];
  moments: MomentDoc[];
}

// ---- self-tuning harness (GET /api/tuning) ----

/** The knobs the tuner may turn. Older configs may lack some (null/undefined = harness default). */
export interface TuningKnobs {
  retrieval?: string | null;
  source?: string | null;
  k?: number | null;
  briefing?: boolean | null;
  briefing_k?: number | null;
  drop_superseded?: boolean | null;
  recency_weight?: number | null;
  framing?: string | null;
  nudge?: string | null;
}

export interface TuningStep {
  config_id: string;
  config: TuningKnobs;
  hypothesis: string;
  dev_pass_at_1: number;
  dev_evidence_recall: number;
  dev_runs: number;
  accepted: boolean;
}

export interface TuningTest {
  pass_at_1: number;
  evidence_recall: number;
  n_runs: number;
  new_runs?: number;
}

export interface TuningRun {
  _id: string;
  status: "running" | "done" | string;
  start: string;
  best: string;
  dev_cases: string[];
  test_cases: string[];
  steps: TuningStep[];
  test?: Record<string, TuningTest>;
  created_at: ISODate;
}

// ---- GET /api/judge_audit, GET /api/spend ----

export interface JudgeAudit {
  judge?: string;
  auditor?: string;
  n?: number;
  agree?: number;
  agreement?: number;
  disagreements?: unknown[];
}

export interface Spend {
  total_usd: number;
  pi: { runs: number; cost_usd: number };
  llm: { stage: string; model: string; calls: number; cost_usd: number }[];
}
