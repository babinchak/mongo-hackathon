// Headless screenshots of every route using local Google Chrome (no extra deps).
// Usage: npm run dev (in another shell), then `npm run screenshots [-- --base http://localhost:5173 --live]`
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "http://localhost:5173";
const live = args.includes("--live");
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "screenshots");
mkdirSync(OUT, { recursive: true });

const CHROME = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));
if (!CHROME) throw new Error("Chrome not found; set CHROME=/path/to/chrome");

const routes = [
  ["overview", "#/overview"],
  ["leaderboard", "#/leaderboard"],
  ["leaderboard-all", "#/leaderboard?repo=all"],
  ["evolution", "#/evolution"],
  ["cases", "#/cases"],
  ["case", `#/cases/${encodeURIComponent("c:m:t_4c1e9a")}`],
  ["case-superseded", `#/cases/${encodeURIComponent("c:m:t_91b0d3")}`],
  ["moments", "#/moments"],
  ["review", "#/review"],
  ["timeline", "#/timeline"],
];
const shots = [
  { suffix: "", size: "1280,800", theme: "light" },
  { suffix: "-full", size: "1280,2600", theme: "light" },
  { suffix: "-dark", size: "1280,800", theme: "dark" },
];

for (const [name, hash] of routes) {
  for (const s of shots) {
    const q = new URLSearchParams();
    if (!live) q.set("fixtures", "");
    q.set("theme", s.theme);
    const url = `${base}/?${q.toString().replace("fixtures=", "fixtures")}${hash}`;
    const file = join(OUT, `${name}${s.suffix}.png`);
    try {
      execFileSync(CHROME, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--user-data-dir=${join(OUT, ".chrome-profile")}`,
      "--no-first-run",
      `--window-size=${s.size}`,
      "--virtual-time-budget=6000",
      `--screenshot=${file}`,
      url,
      ], { stdio: "ignore", timeout: 40000, killSignal: "SIGKILL" });
      console.log(file);
    } catch (e) {
      console.error(`FAILED ${file}: ${e.message.split("\n")[0]}`);
    }
  }
}
