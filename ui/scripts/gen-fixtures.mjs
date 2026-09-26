// Generates synthetic-but-plausible fixture JSON for the UI (repo FSM1/cipher-box).
// Shapes follow CONTRACTS.md. Run: `npm run fixtures` (deterministic; seeded RNG).
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "fixtures");
mkdirSync(OUT, { recursive: true });

const REPO = "FSM1/cipher-box";
const FAR = "9999-12-31T00:00:00Z";
const MODEL = "gpt-5.4-mini";

let seed = 20260926;
function rng() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (a) => a[Math.floor(rng() * a.length)];
const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rng() * 16)]).join("");
const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
const addDays = (s, d) => iso(new Date(s).getTime() + d * 86400000);
const addSecs = (s, x) => iso(new Date(s).getTime() + x * 1000);
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------- configs
const configs = [
  { _id: "repo_only", label: "Repo only (no memory)", memory: false },
  { _id: "vector_turns", label: "Vector · turns", memory: true, retrieval: "vector", source: "turns", k: 8, briefing: false, drop_superseded: false, recency_weight: 0 },
  { _id: "hybrid_turns", label: "Hybrid · turns", memory: true, retrieval: "hybrid", source: "turns", k: 8, briefing: false, drop_superseded: false, recency_weight: 0 },
  { _id: "hybrid_all", label: "Hybrid · moments+turns", memory: true, retrieval: "hybrid", source: "moments+turns", k: 8, briefing: false, drop_superseded: true, recency_weight: 0 },
  { _id: "hybrid_all_brief", label: "Hybrid · moments+turns · briefing", memory: true, retrieval: "hybrid", source: "moments+turns", k: 8, briefing: true, drop_superseded: true, recency_weight: 0 },
  { _id: "ablate_superseded", label: "Ablation · keep superseded", memory: true, retrieval: "hybrid", source: "moments+turns", k: 8, briefing: true, drop_superseded: false, recency_weight: 0 },
];

// ---------------------------------------------------------------- cases
// Each spec: a real-looking correction moment, its conversation, and plan templates.
const specs = [
  {
    turn: "t_4c1e9a", session: "s_0212a", ts: "2026-02-12T15:42:10Z", seq0: 40, src: 2,
    scenario: "durable_constraint", kind: "constraint", topic: "release process", confidence: 5,
    status: "approved", review: { verdict: "approve", reason: "Stated twice in two weeks; nothing in the repo says it." },
    repeated: true,
    moment: "Releases are cut by merging the release-please PR (\"chore(main): release …\"). Never create git tags or bump versions by hand.",
    convo: [
      ["user", "Let's ship the sharing fixes as 0.8.2 today.", null],
      ["assistant", "Sure. I'll bump the version in apps/web/package.json, commit, then run `git tag v0.8.2 && git push --tags` so the deploy workflow picks it up.", null],
      ["user", "Please don't tag releases by hand. We use release-please: merge the open \"chore(main): release\" PR and it creates the tag and the changelog. A manual tag last time left the changelog out of sync.", "correction"],
      ["assistant", "Understood, no manual tags. Release-please PR #214 is open; I'll check that the fix commits use conventional `fix:` prefixes so they land in the changelog, then you can merge it.", null],
      ["user", "Yes, that's right. Thanks.", null],
    ],
    task: "The team wants to publish the new shared-folder links feature as the next minor release. Plan the steps to get version 0.9.0 released.",
    expected: "Confirm the feature commits use conventional prefixes (feat:), then merge the release-please \"chore(main): release 0.9.0\" PR, which creates the tag, GitHub release and changelog. No git tag, npm version, or hand-edited version fields.",
    fail_signals: ["git tag", "npm version", "git push --tags"],
    keywords: ["release", "release-please", "tag", "changelog", "version"],
    queries: ["release process", "how are releases tagged"],
    reads: [["read", { path: "package.json" }], ["read", { path: ".github/workflows/deploy.yml" }], ["ls", { path: ".github/workflows" }], ["read", { path: "apps/web/package.json" }], ["grep", { pattern: "version", path: "apps/web" }], ["read", { path: "CHANGELOG.md" }], ["read", { path: "release-please-config.json" }]],
    pass: `## Plan: release 0.9.0

1. Check that the shared-folder links commits on main use conventional prefixes (\`feat(sharing): …\`) so release-please classifies them as a minor bump.
2. Open the pending release-please PR ("chore(main): release 0.9.0"). Review the generated CHANGELOG.md entries and the version bumps it proposes for apps/web and apps/api.
3. Merge that PR. Release-please creates the v0.9.0 tag and the GitHub release; deploy.yml runs on the release event.
4. Do not create tags or edit version fields by hand; the release PR owns both.
5. After deploy, smoke-test link creation and revocation on production.`,
    fail: `## Plan: release 0.9.0

1. Update "version" to 0.9.0 in apps/web/package.json and apps/api/package.json (or run \`npm version minor\` in each).
2. Add a 0.9.0 section to CHANGELOG.md describing shared-folder links.
3. Commit: \`chore: release 0.9.0\`.
4. Tag and push: \`git tag v0.9.0 && git push origin main --tags\`.
5. deploy.yml triggers on tags matching v*, so the deploy starts automatically.`,
    passReason: ["Plan merges the release-please PR and explicitly avoids manual tags; matches expected behavior.", "Relies on release-please to create tag and changelog; checks conventional commit prefixes first. Matches expected."],
    failReason: ["Plan bumps versions by hand and runs `git tag v0.9.0` (fail signal: git tag). Release-please is not mentioned.", "Plan edits package.json versions and pushes tags manually (fail signals: npm version, git push --tags)."],
  },
  {
    turn: "t_91b0d3", session: "s_0203b", ts: "2026-02-03T10:18:44Z", seq0: 12, src: 1,
    scenario: "superseded_decision", kind: "decision", topic: "test runner", confidence: 4,
    status: "approved", review: { verdict: "approve", reason: "Root jest.config still exists at cutoff, so the repo actively misleads. Good superseded case." },
    repeated: false,
    moment: "packages/crypto moved from Jest to Vitest (Jest failed on the ESM-only noble libraries). New tests use vitest via `pnpm --filter @cipherbox/crypto test`; do not add Jest configs.",
    old: { turn: "t_2a77f0", session: "s_0114a", ts: "2026-01-14T16:05:31Z", text: "Use Jest with the ts-jest preset for all packages; a shared jest.config.base.ts lives at the repo root." },
    convo: [
      ["assistant", "I added `jest.config.ts` to packages/crypto with the ts-jest preset, matching the root config.", null],
      ["user", "We switched crypto to Vitest last week. Jest kept failing on the ESM-only noble libraries. Please use vitest and remove that jest config.", "correction"],
      ["assistant", "Got it. Removed jest.config.ts, added vitest.config.ts with `environment: 'node'`, and converted the two spec files to import from 'vitest'.", null],
      ["user", "Great. The other packages will follow over time, so please don't add new Jest configs anywhere.", null],
    ],
    task: "Add unit tests for the new rotateVaultKey() helper in packages/crypto, covering re-wrapping of every file key under the new vault key.",
    expected: "Vitest tests (import { describe, it, expect } from 'vitest') under packages/crypto, run with `pnpm --filter @cipherbox/crypto test`. No Jest, ts-jest or @types/jest.",
    fail_signals: ["jest.config", "ts-jest", "@types/jest"],
    keywords: ["vitest", "jest", "crypto", "tests"],
    queries: ["test runner for packages/crypto", "jest vs vitest"],
    reads: [["ls", { path: "packages/crypto" }], ["read", { path: "packages/crypto/package.json" }], ["read", { path: "jest.config.base.ts" }], ["read", { path: "packages/crypto/src/rotate.ts" }], ["find", { pattern: "*.spec.ts", path: "packages/crypto" }], ["read", { path: "packages/crypto/src/wrap.spec.ts" }]],
    pass: `## Plan: tests for rotateVaultKey()

1. packages/crypto runs on Vitest (vitest.config.ts); the root jest.config.base.ts is legacy and not used here.
2. Add packages/crypto/src/rotate.spec.ts importing { describe, it, expect } from "vitest".
3. Cases: every file key re-wrapped under the new vault key; old key can no longer unwrap; empty vault; a corrupted wrapped key throws and leaves the vault untouched.
4. Use deterministic keys from the existing test helpers (fixtures/keys.ts).
5. Run \`pnpm --filter @cipherbox/crypto test\`.`,
    fail: `## Plan: tests for rotateVaultKey()

1. Create packages/crypto/jest.config.ts extending the root jest.config.base.ts (ts-jest preset).
2. Add @types/jest to packages/crypto devDependencies.
3. Write src/rotate.test.ts with describe/it blocks: all file keys re-wrapped, old key rejected, empty vault.
4. Run \`pnpm jest packages/crypto\`.`,
    passReason: ["Uses Vitest and the package-scoped test command; no Jest config. Matches expected.", "Recognises the root Jest config as legacy and writes Vitest specs. Matches expected."],
    failReason: ["Plan creates jest.config.ts with ts-jest (fail signals: jest.config, ts-jest). Follows the superseded January decision.", "Adds @types/jest and a Jest config for packages/crypto; the package moved to Vitest."],
  },
  {
    turn: "t_e5d812", session: "s_0226a", ts: "2026-02-26T19:07:02Z", seq0: 63, src: 1,
    scenario: "failed_approach", kind: "failed_approach", topic: "chunked encryption", confidence: 5,
    status: "approved", review: { verdict: "approve", reason: "Security-relevant failed approach; not documented in code comments at the cutoff." },
    repeated: false,
    moment: "Chunked AES-GCM with one IV per file broke decryption after chunk 1 (nonce reuse). Chunked uploads must use per-chunk nonces (random 8-byte prefix + 4-byte counter) stored in file header v2.",
    convo: [
      ["user", "The 3 GB upload test decrypts to garbage after the first chunk.", "failure_report"],
      ["assistant", "The streaming path encrypts each 4 MiB chunk with AES-GCM using the file's single IV. Reusing an IV under the same key breaks GCM. I'll derive a per-chunk nonce from a random 8-byte prefix plus a 4-byte chunk counter and store the prefix in the file header.", null],
      ["user", "OK. Let's make sure we never go back to one IV per file for chunked uploads.", "correction"],
      ["assistant", "Done: per-chunk nonces, header v2 stores the prefix, and the round-trip test now covers 3 GB.", null],
    ],
    task: "Add resumable uploads for files over 2 GB so an interrupted upload can continue from the last completed chunk.",
    expected: "Reuse the chunked path with per-chunk nonces (prefix + counter, header v2); resume by chunk index so each chunk keeps its own nonce. Never a single IV per file.",
    fail_signals: ["single IV", "reuse the IV", "one IV per file"],
    keywords: ["upload", "chunk", "AES-GCM", "nonce", "IV", "resume"],
    queries: ["chunked upload encryption", "AES-GCM IV per chunk"],
    reads: [["read", { path: "apps/web/src/upload/uploader.ts" }], ["read", { path: "packages/crypto/src/stream.ts" }], ["grep", { pattern: "iv", path: "packages/crypto/src" }], ["read", { path: "packages/crypto/src/header.ts" }], ["read", { path: "apps/api/src/files/upload.controller.ts" }], ["ls", { path: "apps/api/src/files" }]],
    pass: `## Plan: resumable uploads > 2 GB

1. Keep the header v2 format: random 8-byte nonce prefix per file, 4-byte chunk counter per chunk. Each chunk's nonce = prefix || counter.
2. Persist upload state (file id, prefix, last acknowledged chunk index) in IndexedDB on the client.
3. On resume, fetch the server's last committed chunk index, then continue encrypting from index + 1 with nonce = prefix || (index + 1). Never re-encrypt a chunk under a different nonce.
4. API: add GET /files/:id/upload-state and make PUT /files/:id/chunks/:n idempotent.
5. Tests: kill the upload at chunk 300 of 750, resume, and verify a byte-exact decrypt.`,
    fail: `## Plan: resumable uploads > 2 GB

1. Generate one IV per file when the upload starts and store it with the upload session.
2. Encrypt each 4 MiB chunk with AES-GCM using that single IV so the resume path doesn't need extra state.
3. Track the last uploaded chunk index on the server; on resume, continue from there.
4. Add GET /files/:id/upload-state.
5. Test by interrupting an upload and resuming.`,
    passReason: ["Keeps per-chunk nonces (prefix + counter) and resumes by chunk index. Matches expected.", "Explicitly derives each chunk nonce from the header prefix and counter. Matches expected."],
    failReason: ["Plan uses a single IV for every chunk of the file (fail signal: single IV), which is the approach that broke decryption.", "Stores one IV per upload session and reuses it across chunks (fail signal: one IV per file)."],
  },
  {
    turn: "t_7f3b55", session: "s_0305a", ts: "2026-03-05T13:26:50Z", seq0: 22, src: 2,
    scenario: "superseded_decision", kind: "decision", topic: "client cache storage", confidence: 4,
    status: "approved", review: { verdict: "approve", reason: "Clear supersession; localStorage code still present at the 7-day cutoff." },
    repeated: false,
    moment: "The folder-tree cache moved from localStorage to IndexedDB via Dexie (apps/web/src/db/vaultCache.ts). localStorage hit the 5 MB quota and held decrypted names in plaintext.",
    old: { turn: "t_c40e19", session: "s_0122b", ts: "2026-01-22T11:40:12Z", text: "Cache the decrypted folder tree in localStorage as JSON so reloads are instant." },
    convo: [
      ["user", "Large vaults fail to load after refresh. The console shows QuotaExceededError.", "failure_report"],
      ["assistant", "The folder tree cache is serialized to localStorage. I can compress it with lz-string to stay under the quota.", null],
      ["user", "Let's not patch localStorage. We decided to move the cache to IndexedDB with Dexie; that also keeps decrypted names out of plain localStorage. There's a stub in apps/web/src/db.", "rejection"],
      ["assistant", "Makes sense. I'll implement vaultCache.ts on the Dexie stub, encrypt names at rest with the session key, and remove the localStorage path.", null],
    ],
    task: "Persist the user's expanded/collapsed folder state across page reloads.",
    expected: "Store expanded-folder state with the Dexie-based vault cache in apps/web/src/db (IndexedDB), not localStorage or sessionStorage.",
    fail_signals: ["localStorage", "sessionStorage"],
    keywords: ["folder tree", "cache", "IndexedDB", "Dexie", "localStorage"],
    queries: ["folder tree cache storage", "where to persist client state"],
    reads: [["read", { path: "apps/web/src/components/FolderTree.tsx" }], ["grep", { pattern: "localStorage", path: "apps/web/src" }], ["ls", { path: "apps/web/src/db" }], ["read", { path: "apps/web/src/db/index.ts" }], ["read", { path: "apps/web/src/state/vault.ts" }]],
    pass: `## Plan: persist expanded folders

1. Add an \`expanded\` table to the Dexie schema in apps/web/src/db/vaultCache.ts (key: vaultId + folderId), bumping the Dexie version.
2. FolderTree.tsx: on toggle, write through a small useExpandedFolders() hook; on mount, hydrate from Dexie before first render of children.
3. Folder ids only; no decrypted names stored.
4. Clear the table on logout together with the rest of the vault cache.
5. Test with fake-indexeddb: toggle, reload, state restored.`,
    fail: `## Plan: persist expanded folders

1. In FolderTree.tsx, keep a Set of expanded folder ids.
2. On toggle, serialize the set to localStorage under \`cb:expanded:<vaultId>\`.
3. On mount, read it back from localStorage and hydrate the set.
4. Clear the key on logout.`,
    passReason: ["Uses the Dexie vault cache in apps/web/src/db and avoids localStorage. Matches expected.", "Stores ids in IndexedDB via Dexie and clears on logout. Matches expected."],
    failReason: ["Plan stores expanded state in localStorage (fail signal: localStorage), the storage the project moved away from.", "Uses localStorage keyed by vault id; the cache moved to Dexie/IndexedDB in March."],
  },
  {
    turn: "t_b82a4c", session: "s_0318a", ts: "2026-03-18T09:51:37Z", seq0: 8, src: 1,
    scenario: "durable_constraint", kind: "constraint", topic: "branch naming", confidence: 4,
    status: "validated", review: null,
    repeated: false,
    moment: "Branch names must start with feat/ or chore/ (preview deploys only trigger for those). Bug fixes use a `fix:` commit prefix, not a fix/ branch.",
    convo: [
      ["assistant", "I created the branch `fix/heic-thumbnails` and pushed it.", null],
      ["user", "Could you rename that? Preview deploys only run for feat/* and chore/* branches here. For bug fixes use one of those and put `fix:` in the commit message instead.", "correction"],
      ["assistant", "Renamed to chore/heic-thumbnails and re-pushed; the preview workflow is running now.", null],
    ],
    task: "Avatar upload in account settings silently fails for PNGs over 5 MB. Plan the fix and how you'll get it reviewed.",
    expected: "Work on a feat/ or chore/ branch (e.g. chore/avatar-size-limit) with a `fix:` conventional commit so a preview deploy is created. Not a fix/ branch.",
    fail_signals: ["fix/", "checkout -b fix"],
    keywords: ["branch", "preview", "fix", "avatar"],
    queries: ["branch naming convention", "preview deploy branches"],
    reads: [["read", { path: "apps/web/src/settings/AvatarUpload.tsx" }], ["read", { path: "apps/api/src/users/avatar.controller.ts" }], ["grep", { pattern: "MAX_AVATAR", path: "apps" }], ["read", { path: ".github/workflows/preview.yml" }]],
    pass: `## Plan: large PNG avatar uploads

1. Branch: \`chore/avatar-size-limit\` (preview deploys only run for feat/* and chore/*).
2. Client: AvatarUpload.tsx resizes images over 1024 px with createImageBitmap + OffscreenCanvas before upload, and surfaces the API error instead of swallowing it.
3. API: raise MAX_AVATAR_BYTES to 8 MB and return 413 with a message when exceeded.
4. Commit as \`fix(settings): handle avatars over 5 MB\`.
5. Open a PR; verify on the preview deploy with a 7 MB PNG.`,
    fail: `## Plan: large PNG avatar uploads

1. \`git checkout -b fix/avatar-upload-size\`.
2. Client: resize large images before upload and show the error message.
3. API: raise MAX_AVATAR_BYTES to 8 MB, return 413 when exceeded.
4. Commit \`fix(settings): handle avatars over 5 MB\` and open a PR for review.`,
    passReason: ["Uses a chore/ branch with a fix: commit so the preview deploy runs. Matches expected.", "Names the branch chore/… and explains why. Matches expected."],
    failReason: ["Plan creates a fix/ branch (fail signal: fix/), which gets no preview deploy.", "Branch `fix/avatar-upload-size` violates the feat/ or chore/ convention (fail signal: checkout -b fix)."],
  },
  {
    turn: "t_0da6e2", session: "s_0401a", ts: "2026-04-01T17:12:05Z", seq0: 31, src: 2,
    scenario: "failed_approach", kind: "failed_approach", topic: "e2e environment", confidence: 5,
    status: "validated", review: null,
    repeated: true,
    moment: "E2E tests against the shared staging API were flaky (shared test users, key rotation mid-run); retries did not fix it. Run e2e via `pnpm e2e:local` (docker-compose stack, per-run seeded users).",
    convo: [
      ["user", "The Playwright run failed again on the share-link test, but it passes locally for me.", "failure_report"],
      ["assistant", "The CI job points E2E_BASE_URL at the shared staging API, and another job rotated the test user's keys mid-run. I can add retries to that test.", null],
      ["user", "Retries didn't help last time either. Please run e2e against the local docker-compose stack (`pnpm e2e:local`) so each run seeds its own users. Staging is off-limits for e2e.", "correction"],
      ["assistant", "Switched CI to `pnpm e2e:local`, which starts docker compose and seeds users per run. Three consecutive green runs.", null],
    ],
    task: "Add an end-to-end test for revoking a shared folder link and make sure it runs in CI.",
    expected: "Playwright test under apps/web/e2e run with `pnpm e2e:local` (docker-compose stack, seeded users). Not against staging, not relying on retries.",
    fail_signals: ["staging.cipherbox", "E2E_BASE_URL=https://staging"],
    keywords: ["e2e", "playwright", "staging", "docker-compose", "share link"],
    queries: ["how to run e2e tests", "e2e staging flaky"],
    reads: [["ls", { path: "apps/web/e2e" }], ["read", { path: "apps/web/playwright.config.ts" }], ["read", { path: "apps/web/e2e/share-link.spec.ts" }], ["read", { path: ".github/workflows/ci.yml" }], ["read", { path: "package.json" }]],
    pass: `## Plan: e2e for revoking a shared link

1. Add apps/web/e2e/share-revoke.spec.ts next to share-link.spec.ts, reusing its seeded-user fixture.
2. Flow: owner creates link, second browser context opens it, owner revokes, second context reloads and gets the "link revoked" page.
3. Run locally and in CI with \`pnpm e2e:local\` (docker-compose API + seeded users per run). No staging URL, no retries.
4. CI already runs e2e:local in ci.yml; the new spec is picked up by the testDir glob.`,
    fail: `## Plan: e2e for revoking a shared link

1. Add apps/web/e2e/share-revoke.spec.ts.
2. Flow: create link as owner, open in a second context, revoke, verify the second context is blocked.
3. Run in CI with \`E2E_BASE_URL=https://staging.cipherbox.dev pnpm playwright test\`.
4. Set \`retries: 2\` for this spec, since share tests are known to be flaky.`,
    passReason: ["Runs via pnpm e2e:local with seeded users; no staging. Matches expected.", "Reuses the seeded-user fixture and the docker-compose stack. Matches expected."],
    failReason: ["Plan targets the shared staging API (fail signal: E2E_BASE_URL=https://staging) and adds retries.", "Runs e2e against staging.cipherbox.dev (fail signal), the approach that was flaky."],
  },
];

const extraCases = [
  {
    turn: "t_5e20aa", session: "s_0129a", ts: "2026-01-29T14:02:19Z", scenario: "durable_constraint", kind: "constraint", topic: "package manager",
    moment: "Use pnpm, never npm or yarn, in this monorepo.",
    task: "Add the zod library to apps/api for request validation.",
    expected: "pnpm --filter @cipherbox/api add zod.", fail_signals: ["npm install", "yarn add"],
    status: "rejected", chat_only: true, review: { verdict: "reject", reason: "Any agent infers pnpm from pnpm-lock.yaml and the packageManager field. Not chat-only in practice." },
    validation: { repo_only: ["pass", "fail"], oracle: ["pass", "pass"] },
  },
  {
    turn: "t_a19c07", session: "s_0209a", ts: "2026-02-09T10:44:51Z", scenario: "durable_constraint", kind: "constraint", topic: "formatting",
    moment: "Prettier printWidth is 100; don't reformat unrelated files.",
    task: "Refactor the share dialog into smaller components.",
    expected: "Keep printWidth 100 and only format touched files.", fail_signals: ["printWidth: 80"],
    status: "filtered_out", chat_only: false, review: null, validation: undefined,
  },
];

// ---------------------------------------------------------------- sessions
const sessions = [];
const sessionIds = new Set();
function addSession(id, ts, prompts, branch) {
  if (sessionIds.has(id)) return;
  sessionIds.add(id);
  sessions.push({ _id: id, repo_id: REPO, started_at: ts, agent: "Claude Code", prompts, branch });
}
for (const s of [...specs, ...extraCases]) addSession(s.session, addSecs(s.ts, -3600 * (1 + rng() * 2)), 20 + Math.floor(rng() * 50), "main");
for (const s of specs) if (s.old) addSession(s.old.session, addSecs(s.old.ts, -3000), 15 + Math.floor(rng() * 40), "main");
{
  const branches = ["main", "main", "main", "feat/sharing-links", "chore/ci-cache", "feat/vault-rotation", "feat/heic", "chore/deps"];
  let t = new Date("2026-01-05T15:00:00Z").getTime();
  const end = new Date("2026-04-14T00:00:00Z").getTime();
  let i = 0;
  while (t < end) {
    t += (0.6 + rng() * 2.6) * 86400000;
    const d = new Date(t);
    const id = `s_${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}${"xyzw"[i++ % 4]}`;
    addSession(id, iso(t), 3 + Math.floor(rng() ** 1.6 * 90), pick(branches));
  }
}
sessions.sort((a, b) => a.started_at.localeCompare(b.started_at));
const sessionAt = (ts) => {
  let best = sessions[0];
  for (const s of sessions) if (s.started_at <= ts) best = s;
  return best._id;
};

// ---------------------------------------------------------------- memory: moments + turns
const moments = [];
const turns = [];
const mkMoment = (o) => ({
  _id: `m:${o.turn}`, kind: "moment", repo_id: REPO, session_id: o.session, seq: o.seq ?? 0, ts: o.ts, text: o.text,
  durable: o.durable ?? true, superseded_at: o.superseded_at ?? FAR, moment_kind: o.kind, topic: o.topic,
  confidence: o.confidence ?? 4, source_turn_id: o.turn, evidence: o.evidence ?? [o.turn],
  repeats: o.repeats ?? [], repeated_by: o.repeated_by ?? [], supersedes: o.supersedes ?? [], superseded_by: o.superseded_by ?? [],
});

for (const s of specs) {
  const ids = s.convo.map((_, i) => (i === s.src ? s.turn : `t_${hex(6)}`));
  s.turnIds = ids;
  s.convo.forEach(([role, text, pushback], i) => {
    turns.push({
      _id: ids[i], kind: "turn", repo_id: REPO, session_id: s.session, seq: s.seq0 + i,
      ts: addSecs(s.ts, (i - s.src) * 75), text, durable: false, superseded_at: FAR,
      role, pushback, noise: false,
    });
  });
  // evidence = the pushback turn + the assistant turn that acknowledges it
  s.evidence = [s.turn, ids[s.src + 1]].filter(Boolean);
  const m = mkMoment({ turn: s.turn, session: s.session, seq: s.seq0 + s.src, ts: s.ts, text: s.moment, kind: s.kind, topic: s.topic, confidence: s.confidence, evidence: s.evidence });
  if (s.repeated) {
    const rid = `t_${hex(6)}`;
    const rts = addDays(s.ts, 9 + Math.floor(rng() * 5));
    const rs = sessionAt(rts);
    const rm = mkMoment({ turn: rid, session: rs, seq: 14, ts: rts, text: `(repeat) ${s.moment}`, kind: s.kind, topic: s.topic, confidence: 4, repeats: [m._id] });
    m.repeated_by = [rm._id];
    moments.push(rm);
  }
  if (s.old) {
    const om = mkMoment({ turn: s.old.turn, session: s.old.session, seq: 9, ts: s.old.ts, text: s.old.text, kind: "decision", topic: s.topic, confidence: 4, superseded_by: [m._id], superseded_at: s.ts });
    m.supersedes = [om._id];
    moments.push(om);
    s.oldMomentId = om._id;
  }
  moments.push(m);
  s.momentId = m._id;
}
for (const e of extraCases) {
  moments.push(mkMoment({ turn: e.turn, session: e.session, seq: 5, ts: e.ts, text: e.moment, kind: e.kind, topic: e.topic, confidence: 3 }));
  turns.push({ _id: e.turn, kind: "turn", repo_id: REPO, session_id: e.session, seq: 5, ts: e.ts, text: e.moment, durable: false, superseded_at: FAR, role: "user", pushback: "correction", noise: false });
}

// Background moments for the timeline
const background = [
  ["fact", "architecture", "Files are encrypted client-side; the API only ever sees ciphertext and wrapped keys."],
  ["fact", "infra", "Pinning goes through the self-hosted IPFS cluster; public gateways are read-only fallbacks."],
  ["procedure", "local dev", "Run `pnpm dev` from the root; it starts api, web and the local IPFS node via turbo."],
  ["procedure", "migrations", "Database migrations: `pnpm --filter @cipherbox/api migration:generate`, never hand-written SQL."],
  ["constraint", "security", "Never log decrypted file names or key material, including in debug builds."],
  ["constraint", "dependencies", "Crypto primitives come from @noble/* only; no other crypto libraries."],
  ["decision", "auth", "Session tokens live in httpOnly cookies; access tokens are not stored in JS-readable storage."],
  ["decision", "api style", "New endpoints are REST under /v1; the GraphQL prototype is frozen."],
  ["failed_approach", "thumbnails", "Generating thumbnails server-side was dropped: the server cannot see plaintext."],
  ["failed_approach", "sharing", "Sharing via re-encrypting whole files per recipient was too slow; wrap the file key per recipient instead."],
  ["fact", "ci", "CI caches the pnpm store keyed on pnpm-lock.yaml; a cold build takes about 6 minutes."],
  ["procedure", "key rotation", "Vault key rotation re-wraps file keys in batches of 500 inside one transaction."],
  ["constraint", "ui", "All user-visible strings go through i18n (apps/web/src/i18n); no hard-coded English."],
  ["decision", "state", "Client state uses Zustand; Redux was removed in January."],
  ["fact", "limits", "Free tier storage quota is 5 GB, enforced by the API on chunk commit."],
  ["procedure", "review", "PRs need one approval and a green preview deploy before merge."],
  ["decision", "monorepo", "Shared types live in packages/types and are imported, never copied."],
  ["failed_approach", "search", "Client-side full-text search over encrypted names with lunr was too memory hungry on large vaults."],
];
const bgStart = new Date("2026-01-06T00:00:00Z").getTime();
const bgSpan = new Date("2026-04-12T00:00:00Z").getTime() - bgStart;
for (let i = 0; i < 44; i++) {
  const [kind, topic, text] = background[i % background.length];
  const ts = iso(bgStart + rng() * bgSpan);
  const turn = `t_${hex(6)}`;
  moments.push(mkMoment({ turn, session: sessionAt(ts), seq: Math.floor(rng() * 60), ts, text, kind, topic, confidence: 2 + Math.floor(rng() * 4) }));
}
// a background supersession for the timeline arcs
{
  const a = moments.find((m) => m.topic === "state");
  const ts = addDays(a.ts, 12);
  const b = mkMoment({ turn: `t_${hex(6)}`, session: sessionAt(ts), seq: 3, ts, text: "Zustand store is split per feature slice; the single global store is retired.", kind: "decision", topic: "state", confidence: 4, supersedes: [a._id] });
  a.superseded_by = [b._id];
  a.superseded_at = ts;
  moments.push(b);
}
moments.sort((a, b) => a.ts.localeCompare(b.ts));

// ---------------------------------------------------------------- cases
const cases = [];
for (const s of specs) {
  const cutoffs = [7, 30].map((h) => {
    const cutoff = addDays(s.ts, h);
    return { horizon_days: h, cutoff, session_id: sessionAt(cutoff), commit: hex(40) };
  });
  s.cutoffs = cutoffs;
  cases.push({
    _id: `c:${s.momentId}`, repo_id: REPO, moment_id: s.momentId, scenario: s.scenario, task: s.task, expected: s.expected,
    fail_signals: s.fail_signals, keywords: s.keywords, gold_evidence: [...s.evidence, s.momentId], cutoffs,
    repeated_in_real_life: s.repeated, chat_only: true, status: s.status,
    validation: { repo_only: ["fail", "fail"], oracle: s.turn === "t_b82a4c" ? ["pass", "fail"] : ["pass", "pass"] },
    review: s.review,
  });
  s.caseId = `c:${s.momentId}`;
}
for (const e of extraCases) {
  cases.push({
    _id: `c:m:${e.turn}`, repo_id: REPO, moment_id: `m:${e.turn}`, scenario: e.scenario, task: e.task, expected: e.expected,
    fail_signals: e.fail_signals, keywords: [], gold_evidence: [e.turn, `m:${e.turn}`],
    cutoffs: [7, 30].map((h) => ({ horizon_days: h, cutoff: addDays(e.ts, h), session_id: sessionAt(addDays(e.ts, h)), commit: hex(40) })),
    repeated_in_real_life: false, chat_only: e.chat_only, status: e.status,
    ...(e.validation ? { validation: e.validation } : {}), review: e.review,
  });
}

// ---------------------------------------------------------------- runs
const P = {
  durable_constraint: { repo_only: 0.08, vector_turns: 0.45, hybrid_turns: 0.62, hybrid_all: 0.78, hybrid_all_brief: 0.93, ablate_superseded: 0.9 },
  superseded_decision: { repo_only: 0.05, vector_turns: 0.2, hybrid_turns: 0.3, hybrid_all: 0.62, hybrid_all_brief: 0.85, ablate_superseded: 0.28 },
  failed_approach: { repo_only: 0.12, vector_turns: 0.35, hybrid_turns: 0.5, hybrid_all: 0.7, hybrid_all_brief: 0.8, ablate_superseded: 0.78 },
};
const GOLD = { vector_turns: 0.3, hybrid_turns: 0.55, hybrid_all: 0.85, hybrid_all_brief: 0.92, ablate_superseded: 0.9 };
const distractorIds = moments.slice(0, 40).map((m) => m._id).concat(turns.map((t) => t._id));

const runs = [];
for (const s of specs) {
  for (const cfg of configs) {
    for (const c of s.cutoffs) {
      for (let r = 0; r < 3; r++) {
        let p = P[s.scenario][cfg._id];
        if (c.horizon_days === 30 && cfg.source === "turns") p -= 0.12;
        if (c.horizon_days === 30 && cfg._id === "hybrid_all") p -= 0.05;
        const isError = rng() < 0.025;
        const pass = !isError && rng() < p;
        const mem = cfg.memory;
        const used = mem && (pass ? rng() < 0.97 : rng() < 0.8);
        const hit = mem && (cfg.briefing || used) && (pass ? rng() < Math.max(GOLD[cfg._id], 0.7) : rng() < GOLD[cfg._id] * 0.5);
        // tool calls
        const reads = s.reads.slice(0, 3 + Math.floor(rng() * (s.reads.length - 2)));
        const calls = [["ls", { path: "." }], ...reads];
        if (used) {
          calls.splice(1, 0, ["search_memory", { query: s.queries[0] }]);
          if (rng() < 0.45) calls.splice(3 + Math.floor(rng() * 2), 0, ["search_memory", { query: s.queries[1] }]);
        }
        const tool_calls = calls.map(([tool, args]) => ({ tool, args }));
        let context_ids = [];
        if (mem && (used || cfg.briefing)) {
          const d = Array.from({ length: 3 + Math.floor(rng() * 4) }, () => pick(distractorIds));
          context_ids = hit ? [s.momentId, s.turn, ...d] : d;
          if (s.oldMomentId && (cfg._id === "ablate_superseded" || cfg.source === "turns" || rng() < 0.2)) context_ids.splice(1, 0, s.oldMomentId);
          context_ids = [...new Set(context_ids)];
        }
        const created = addSecs("2026-09-26T13:05:00Z", Math.floor(rng() * 5400));
        let response = pass ? s.pass : s.fail;
        let reason = pass ? pick(s.passReason) : pick(s.failReason);
        if (pass && used && hit) response = `Project memory (search_memory) returned a relevant note from ${s.ts.slice(0, 10)}: "${s.moment.slice(0, 90)}${s.moment.length > 90 ? "…" : ""}"\n\n${response}`;
        if (!pass && cfg._id === "ablate_superseded" && s.scenario === "superseded_decision" && hit) reason += " Memory returned both the old and the new decision; the plan followed the older one.";
        if (isError) { response = ""; reason = "Run error: pi exited after 120 s timeout without a final message."; }
        runs.push({
          _id: uuid(), case_id: s.caseId, config_id: cfg._id, repeat: r, horizon_days: c.horizon_days, cutoff: c.cutoff, commit: c.commit,
          model: MODEL, tool_calls, used_memory_tool: !!used, context_ids, hit_gold: !!hit, response,
          verdict: isError ? "error" : pass ? "pass" : "fail", reason,
          cost_usd: round((mem ? 0.028 : 0.022) + rng() * 0.024 + (used ? 0.004 : 0), 4),
          turns: 6 + Math.floor(rng() * 9), duration_s: round(isError ? 120 : 17 + rng() * 21, 1), created_at: created,
        });
      }
    }
  }
}

// ---------------------------------------------------------------- aggregates
function stats(rs) {
  const groups = new Map();
  for (const r of rs) {
    const k = `${r.case_id}|${r.horizon_days}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const all3 = [...groups.values()].filter((g) => g.every((r) => r.verdict === "pass")).length;
  return {
    n_cases: new Set(rs.map((r) => r.case_id)).size,
    n_runs: rs.length,
    pass_at_1: round(rs.filter((r) => r.verdict === "pass").length / rs.length),
    pass_pow_3: round(all3 / groups.size),
  };
}
const scenarioOf = Object.fromEntries(cases.map((c) => [c._id, c.scenario]));
const leaderboard = configs.map((cfg) => {
  const rs = runs.filter((r) => r.config_id === cfg._id);
  const by_scenario = {};
  for (const sc of ["durable_constraint", "superseded_decision", "failed_approach"]) by_scenario[sc] = stats(rs.filter((r) => scenarioOf[r.case_id] === sc));
  const by_horizon = {};
  for (const h of [7, 30]) by_horizon[String(h)] = stats(rs.filter((r) => r.horizon_days === h));
  return {
    config_id: cfg._id, label: cfg.label, ...stats(rs),
    evidence_recall: cfg.memory ? round(rs.filter((r) => r.hit_gold).length / rs.length) : null,
    memory_tool_use: cfg.memory ? round(rs.filter((r) => r.used_memory_tool).length / rs.length) : null,
    cost_usd_per_run: round(rs.reduce((a, r) => a + r.cost_usd, 0) / rs.length, 4),
    by_scenario, by_horizon,
  };
});

const funnel = { events: 18432, pushback: 1062, durable_moments: 207, cases: 19, chat_only: 8, validated: 7, approved: 4 };

const write = (name, data) => writeFileSync(join(OUT, name), JSON.stringify(data, null, 1) + "\n");
write("configs.json", configs);
write("cases.json", cases);
write("moments.json", moments);
write("turns.json", turns);
write("runs.json", runs);
write("sessions.json", sessions);
write("leaderboard.json", leaderboard);
write("funnel.json", funnel);

for (const row of leaderboard) console.log(row.config_id.padEnd(18), "p@1", row.pass_at_1, "p^3", row.pass_pow_3, "recall", row.evidence_recall, "use", row.memory_tool_use, "$", row.cost_usd_per_run, "sup", row.by_scenario.superseded_decision.pass_at_1);
console.log(`cases ${cases.length} runs ${runs.length} moments ${moments.length} sessions ${sessions.length}`);
