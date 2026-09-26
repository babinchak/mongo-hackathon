import { useEffect, useState } from "react";
import { getApiStatus, getSnapshotMeta, onApiStatusChange, STATIC, type ApiStatus } from "./api";
import { ALL_REPOS, concreteRepo, fmtDate, fmtShortDate, fmtTime, href, REPOS, setRepo, useAsync, useRepo, useRoute } from "./lib";
import Overview from "./views/Overview";
import Leaderboard from "./views/Leaderboard";
import Evolution from "./views/Evolution";
import CasesList from "./views/CasesList";
import CaseInspector from "./views/CaseInspector";
import Moments from "./views/Moments";
import Review from "./views/Review";
import Timeline from "./views/Timeline";
import RunExplorer from "./views/RunExplorer";
import RunTraceView from "./views/RunTrace";

const NAV = [
  { path: "/overview", label: "Overview", match: ["overview"] },
  { path: "/leaderboard", label: "Leaderboard", match: ["leaderboard", "runs", "run"] },
  { path: "/evolution", label: "Evolution", match: ["evolution"] },
  { path: "/cases", label: "Cases", match: ["cases", "case"] },
  { path: "/moments", label: "Moments", match: ["moments"] },
  { path: "/review", label: "Review", match: ["review"] },
  { path: "/timeline", label: "Timeline", match: ["timeline"] },
];

const STATUS_TEXT: Record<ApiStatus, { label: string; title: string }> = {
  unknown: { label: "connecting…", title: "Waiting for the Hindsight API" },
  live: { label: "live", title: "The Hindsight API (MongoDB Atlas) is responding" },
  offline: { label: "API offline", title: "The Hindsight API is unreachable; pages that fell back to fixtures say so" },
  forced: { label: "fixtures", title: "Synthetic fixture data (?fixtures in URL)" },
  snapshot: { label: "snapshot", title: "Read-only snapshot exported from the live run" },
};

const REPO_URL = "https://github.com/babinchak/mongo-hackathon";

export default function App() {
  const route = useRoute();
  const selected = useRepo();
  // Leaderboard and the run explorer / trace can span every repo; Evolution tunes across all repos; the rest need one repo.
  const allOk = route.name === "leaderboard" || route.name === "runs" || route.name === "run";
  const repo = allOk ? selected : concreteRepo(selected);
  // Overview and Evolution always span every repo.
  const spansAll = route.name === "overview" || route.name === "evolution";
  const [status, setStatus] = useState<ApiStatus>(getApiStatus());
  useEffect(() => onApiStatusChange(setStatus), []);
  const meta = useAsync(() => getSnapshotMeta(), []);
  const exportedAt = meta.data?.exported_at;
  const badge =
    status === "snapshot" && exportedAt
      ? { label: `snapshot · ${fmtShortDate(exportedAt)}, ${fmtTime(exportedAt)} UTC`, title: `${STATUS_TEXT.snapshot.title} on ${fmtDate(exportedAt)} at ${fmtTime(exportedAt)} UTC` }
      : STATUS_TEXT[status];

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href={href("/overview")}>
            <span className="brand-mark" aria-hidden>
              H
            </span>
            Hindsight
          </a>
          <nav className="nav">
            {NAV.map((n) => (
              <a key={n.path} href={href(n.path)} className={n.match.includes(route.name) ? "active" : ""}>
                {n.label}
              </a>
            ))}
          </nav>
          <div className="topbar-right">
            <label
              className="repo-switch"
              title={
                route.name === "evolution"
                  ? "Self-tuning runs over the validated cases of every repo"
                  : route.name === "overview"
                    ? "The overview covers every repo"
                    : "Repository under evaluation (applies to every page)"
              }
            >
              <span className="sr-only">Repository</span>
              <select
                className="mono"
                value={spansAll ? ALL_REPOS : repo}
                disabled={spansAll}
                onChange={(e) => setRepo(e.target.value)}
              >
                {(allOk || spansAll) && <option value={ALL_REPOS}>All repos</option>}
                {repo === ALL_REPOS || (REPOS as readonly string[]).includes(repo) ? null : <option value={repo}>{repo}</option>}
                {REPOS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <span className={`source source-${status}`} title={badge.title}>
              <span className="source-dot" aria-hidden />
              {badge.label}
            </span>
          </div>
        </div>
        {STATIC && (
          <div className="snapshot-banner" role="note">
            Read-only snapshot of a live run ·{" "}
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              source on GitHub
            </a>
          </div>
        )}
      </header>
      <main className="main">
        {route.name === "overview" && <Overview />}
        {route.name === "leaderboard" && <Leaderboard repo={repo === ALL_REPOS ? undefined : repo} />}
        {route.name === "evolution" && <Evolution />}
        {route.name === "cases" && <CasesList repo={repo} />}
        {route.name === "case" && <CaseInspector id={route.id} />}
        {route.name === "moments" && <Moments repo={repo} />}
        {route.name === "review" && <Review repo={repo} />}
        {route.name === "timeline" && <Timeline repo={repo} />}
        {route.name === "runs" && <RunExplorer repo={repo === ALL_REPOS ? undefined : repo} />}
        {route.name === "run" && <RunTraceView id={route.id} repo={repo === ALL_REPOS ? undefined : repo} />}
      </main>
    </div>
  );
}
