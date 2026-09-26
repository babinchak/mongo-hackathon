// Hindsight memory extension for pi.
// Env: HINDSIGHT_API, HINDSIGHT_REPO, HINDSIGHT_CUTOFF (ISO), HINDSIGHT_CONFIG.
// No-op when HINDSIGHT_REPO is unset.
//
// Context ids for the runner:
//   - search_memory results carry { ids, query } in tool result `details`
//     (JSON stream: tool_execution_end.result.details).
//   - a briefing is recorded with pi.appendEntry("hindsight_briefing", { ids, config_id })
//     (JSON stream: entry_appended with entry.customType == "hindsight_briefing").
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Item = {
	id: string;
	kind: "moment" | "turn";
	ts?: string;
	session_id?: string;
	text: string;
	moment_kind?: string;
	topic?: string;
};

const API = (process.env.HINDSIGHT_API || "http://127.0.0.1:8000").replace(/\/$/, "");
const REPO = process.env.HINDSIGHT_REPO;
const CUTOFF = process.env.HINDSIGHT_CUTOFF || new Date().toISOString();
const CONFIG = process.env.HINDSIGHT_CONFIG || "hybrid_all_brief";
const TURN_CHARS = 700;

async function post(path: string, body: object, signal?: AbortSignal): Promise<any> {
	const res = await fetch(`${API}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
	return res.json();
}

async function briefingEnabled(): Promise<boolean> {
	try {
		const res = await fetch(`${API}/api/configs/${encodeURIComponent(CONFIG)}`);
		return res.ok && (await res.json()).briefing === true;
	} catch {
		return false;
	}
}

const day = (ts?: string) => (ts || "").slice(0, 10) || "undated";

function formatItems(items: Item[]): string {
	const moments = items.filter((i) => i.kind === "moment");
	const turns = items.filter((i) => i.kind !== "moment");
	const out: string[] = [];
	if (moments.length) {
		out.push("Notes and decisions:");
		for (const m of moments) {
			const tag = [m.moment_kind, m.topic].filter(Boolean).join(", ");
			out.push(`- [${day(m.ts)}${tag ? ` · ${tag}` : ""}] ${m.text}`);
		}
	}
	if (turns.length) {
		if (out.length) out.push("");
		out.push("Excerpts from earlier sessions:");
		for (const t of turns) {
			const text = t.text.length > TURN_CHARS ? `${t.text.slice(0, TURN_CHARS)}…` : t.text;
			out.push(`- [${day(t.ts)}] ${text.replace(/\s+/g, " ")}`);
		}
	}
	return out.join("\n");
}

export default function (pi: ExtensionAPI) {
	if (!REPO) return;
	const cutoffDay = day(CUTOFF);

	pi.registerTool(
		defineTool({
			name: "search_memory",
			label: "Search memory",
			description:
				`Search notes and decisions from this project's earlier agent sessions (before ${cutoffDay}): ` +
				"constraints the team set, decisions (and what replaced them), procedures, and approaches that failed. " +
				"Use it before planning to learn how this project does things.",
			promptSnippet: `Search notes and decisions from this project's earlier agent sessions (before ${cutoffDay})`,
			promptGuidelines: [
				"Use search_memory early to check for prior decisions, constraints, and failed approaches relevant to the task.",
			],
			parameters: Type.Object({
				query: Type.String({ description: "What to look for, e.g. 'release process' or 'database migrations'" }),
			}),
			async execute(_id, params, signal) {
				const res = await post(
					"/api/memory/search",
					{ repo_id: REPO, cutoff: CUTOFF, query: params.query, config_id: CONFIG },
					signal,
				);
				const items: Item[] = res.items || [];
				const text = items.length ? formatItems(items) : "No matching memory found.";
				return {
					content: [{ type: "text", text }],
					details: { query: params.query, ids: items.map((i) => i.id) },
				};
			},
		}),
	);

	let briefing: boolean | undefined;
	pi.on("before_agent_start", async (event) => {
		briefing ??= await briefingEnabled();
		if (!briefing) return;
		const res = await post("/api/memory/briefing", {
			repo_id: REPO,
			cutoff: CUTOFF,
			query: event.prompt,
			config_id: CONFIG,
		});
		const ids: string[] = res.ids || [];
		pi.appendEntry("hindsight_briefing", { ids, config_id: CONFIG });
		if (!res.text?.trim()) return;
		event.systemPromptOptions.sections.project_memory =
			`Current decisions and constraints from this project's earlier agent sessions (as of ${cutoffDay}):\n` +
			res.text.trim();
	});
}
