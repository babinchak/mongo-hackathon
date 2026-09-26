import { useEffect, useState } from "react";
import { getApiStatus, onApiStatusChange, type ApiStatus } from "./api";
import { href, REPOS, setRepo, useRepo, useRoute } from "./lib";
import Leaderboard from "./views/Leaderboard";
import CasesList from "./views/CasesList";
import CaseInspector from "./views/CaseInspector";
import Moments from "./views/Moments";
import Review from "./views/Review";
import Timeline from "./views/Timeline";

const NAV = [
  { path: "/leaderboard", label: "Leaderboard", match: ["leaderboard"] },
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
};

export default function App() {
  const route = useRoute();
  const repo = useRepo();
  const [status, setStatus] = useState<ApiStatus>(getApiStatus());
  useEffect(() => onApiStatusChange(setStatus), []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href={href("/leaderboard")}>
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
            <label className="repo-switch" title="Repository under evaluation (applies to every page)">
              <span className="sr-only">Repository</span>
              <select className="mono" value={repo} onChange={(e) => setRepo(e.target.value)}>
                {(REPOS as readonly string[]).includes(repo) ? null : <option value={repo}>{repo}</option>}
                {REPOS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <span className={`source source-${status}`} title={STATUS_TEXT[status].title}>
              <span className="source-dot" aria-hidden />
              {STATUS_TEXT[status].label}
            </span>
          </div>
        </div>
      </header>
      <main className="main">
        {route.name === "leaderboard" && <Leaderboard repo={repo} />}
        {route.name === "cases" && <CasesList repo={repo} />}
        {route.name === "case" && <CaseInspector id={route.id} />}
        {route.name === "moments" && <Moments repo={repo} />}
        {route.name === "review" && <Review repo={repo} />}
        {route.name === "timeline" && <Timeline repo={repo} />}
      </main>
    </div>
  );
}
