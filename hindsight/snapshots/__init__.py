"""Point-in-time repo snapshots (no .git) and a keyword grep over them.

commit_at uses the default branch's first-parent history and committer dates: a first-parent
commit's committer date is when that change landed on the default branch, so the snapshot is
what someone cloning the repo at the cutoff would have seen. Walking all parents would pick up
feature-branch commits dated before the cutoff but merged after it (a state the default branch
never had), and author dates survive rebases/cherry-picks, so they can predate the merge.
"""

import math
import os
import re
import shutil
import subprocess
import tarfile
from datetime import datetime, timezone
from pathlib import Path

import hindsight.db  # noqa: F401  (loads .env)

ROOT = Path(__file__).resolve().parents[2]
REPOS_DIR = ROOT / "repos"
# Keep snapshots outside this repo so an agent can't wander from a snapshot into our own files.
SNAPSHOTS_DIR = Path(os.environ.get("HINDSIGHT_SNAPSHOTS_DIR") or ROOT / "snapshots")

SKIP_DIRS = {
    ".git", "node_modules", "dist", "build", "out", "target", "vendor", "coverage",
    ".next", ".nuxt", ".turbo", ".cache", ".venv", "venv", "__pycache__",
}
SKIP_FILES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock",
    "Cargo.lock", "poetry.lock", "uv.lock", "Pipfile.lock", "Gemfile.lock",
    "composer.lock", "go.sum", "flake.lock", "npm-shrinkwrap.json",
}
SKIP_SUFFIXES = (".min.js", ".min.css", ".map", ".snap", ".lock", ".svg")
MAX_FILE_BYTES = 512 * 1024

_fetched: set[str] = set()


def _slug(repo_id: str) -> str:
    owner, name = repo_id.split("/")
    return f"{owner}__{name}"


def _git(repo_dir: Path, *args: str) -> str:
    out = subprocess.run(
        ["git", "-C", str(repo_dir), *args], check=True, capture_output=True, text=True
    )
    return out.stdout.strip()


def _utc(dt: datetime | str) -> datetime:
    if isinstance(dt, str):
        dt = datetime.fromisoformat(dt.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def repo_dir(repo_id: str) -> Path:
    return REPOS_DIR / _slug(repo_id)


def ensure_clone(repo_id: str) -> tuple[Path, str]:
    """Blobless clone (or fetch once per process). Returns (repo dir, default branch)."""
    path = repo_dir(repo_id)
    if not (path / ".git").exists():
        REPOS_DIR.mkdir(exist_ok=True)
        subprocess.run(
            ["git", "clone", "--quiet", "--filter=blob:none", "--no-checkout",
             f"https://github.com/{repo_id}", str(path)],
            check=True, capture_output=True, text=True,
        )
    elif repo_id not in _fetched:
        _git(path, "fetch", "--quiet", "--prune", "origin")
        _git(path, "remote", "set-head", "origin", "--auto")
    _fetched.add(repo_id)
    # Highest-precedence attributes: archive every tracked file verbatim.
    (path / ".git" / "info").mkdir(exist_ok=True)
    (path / ".git" / "info" / "attributes").write_text("* -export-ignore -export-subst\n")
    branch = _git(path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").removeprefix("origin/")
    return path, branch


def commit_at(repo_id: str, cutoff: datetime | str) -> tuple[str, datetime]:
    """Last commit on the default branch (first-parent, committer date) strictly before cutoff."""
    path, branch = ensure_clone(repo_id)
    until = math.ceil(_utc(cutoff).timestamp()) - 1
    sha = _git(path, "rev-list", "-1", "--first-parent", f"--before=@{until}", f"origin/{branch}")
    if not sha:
        raise ValueError(f"{repo_id} has no commit on {branch} before {_utc(cutoff).isoformat()}")
    date = _git(path, "log", "-1", "--format=%cI", sha)
    return sha, _utc(date)


def snapshot(repo_id: str, cutoff: datetime | str) -> Path:
    """Extract the repo as of cutoff into snapshots/<owner>__<name>/<sha12>/ (cached, no .git)."""
    sha, _ = commit_at(repo_id, cutoff)
    return snapshot_sha(repo_id, sha)


def snapshot_sha(repo_id: str, sha: str) -> Path:
    path = repo_dir(repo_id)
    dest = SNAPSHOTS_DIR / _slug(repo_id) / sha[:12]
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.parent / f".tmp-{sha[:12]}-{os.getpid()}"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir()
    proc = subprocess.Popen(
        ["git", "-C", str(path), "archive", "--format=tar", sha], stdout=subprocess.PIPE
    )
    try:
        with tarfile.open(fileobj=proc.stdout, mode="r|") as tar:
            for member in tar:
                # Symlinks/hardlinks are skipped: they can point outside the snapshot or be broken.
                if member.isfile() or member.isdir():
                    tar.extract(member, tmp, filter="data")
        if proc.wait() != 0:
            raise RuntimeError(f"git archive {sha} failed in {path}")
        try:
            tmp.rename(dest)
        except OSError:
            if not dest.exists():
                raise
    finally:
        proc.stdout.close()
        proc.wait()
        shutil.rmtree(tmp, ignore_errors=True)
    return dest


def _skip_file(name: str) -> bool:
    return name in SKIP_FILES or name.endswith(SKIP_SUFFIXES)


def _candidate_files(root: Path, keywords: list[str]) -> list[Path]:
    """Files containing any keyword (case-insensitive, fixed string), via rg or grep."""
    rg = shutil.which("rg")
    if rg:
        cmd = [rg, "-l", "-i", "-F", "--hidden", "--no-ignore", "--no-messages",
               f"--max-filesize={MAX_FILE_BYTES}"]
        for d in SKIP_DIRS:
            cmd += ["--glob", f"!{d}/"]
        for f in SKIP_FILES:
            cmd += ["--glob", f"!{f}"]
        for s in SKIP_SUFFIXES:
            cmd += ["--glob", f"!*{s}"]
    else:
        cmd = ["grep", "-rIilF", "--no-messages"]
        cmd += [f"--exclude-dir={d}" for d in SKIP_DIRS]
        cmd += [f"--exclude={f}" for f in SKIP_FILES]
        cmd += [f"--exclude=*{s}" for s in SKIP_SUFFIXES]
    for kw in keywords:
        cmd += ["-e", kw]
    out = subprocess.run([*cmd, "."], cwd=root, capture_output=True, text=True).stdout
    files = []
    for line in out.splitlines():
        p = root / line.removeprefix("./")
        if p.is_file() and not p.is_symlink() and p.stat().st_size <= MAX_FILE_BYTES:
            if not _skip_file(p.name):
                files.append(p)
    return files


def grep_snapshot(
    path: Path | str, keywords: list[str], max_files: int = 8,
    max_snippets: int = 4, context: int = 1, max_line_chars: int = 200,
) -> list[dict]:
    """Rank files by distinct keywords matched, then total hits; return a few context lines each.

    Each result: {"path": relative posix path, "hits": int, "keywords": [...], "lines": [str]}.
    Lines are "<lineno>: text" with "--" between non-adjacent snippets.
    """
    root = Path(path)
    seen, kws = set(), []
    for kw in keywords:
        k = kw.strip()
        if k and k.lower() not in seen:
            seen.add(k.lower())
            kws.append(k)
    if not kws:
        return []
    patterns = [re.compile(re.escape(k), re.IGNORECASE) for k in kws]

    scored = []
    for f in _candidate_files(root, kws):
        try:
            text = f.read_text(errors="replace")
        except OSError:
            continue
        lines = text.splitlines()
        hits, matched, first_line, line_hits = 0, [], {}, []
        for i, pat in enumerate(patterns):
            n = 0
            for ln, line in enumerate(lines):
                c = len(pat.findall(line))
                if c:
                    n += c
                    first_line.setdefault(i, ln)
                    line_hits.append(ln)
            if n:
                hits += n
                matched.append(kws[i])
        if matched:
            scored.append((len(matched), hits, f, lines, first_line, sorted(set(line_hits)), matched))

    scored.sort(key=lambda s: (-s[0], -s[1], str(s[2])))
    results = []
    for n_kw, hits, f, lines, first_line, line_hits, matched in scored[:max_files]:
        # One snippet per distinct keyword first, then fill with remaining hit lines.
        centers = sorted(set(first_line.values()))[:max_snippets]
        for ln in line_hits:
            if len(centers) >= max_snippets:
                break
            if ln not in centers:
                centers.append(ln)
        keep = sorted({j for c in sorted(centers)
                       for j in range(max(0, c - context), min(len(lines), c + context + 1))})
        out, prev = [], None
        for j in keep:
            if prev is not None and j != prev + 1:
                out.append("--")
            line = lines[j].rstrip()
            if len(line) > max_line_chars:
                line = line[:max_line_chars] + "..."
            out.append(f"{j + 1}: {line}")
            prev = j
        results.append({
            "path": f.relative_to(root).as_posix(), "hits": hits,
            "keywords": matched, "lines": out,
        })
    return results
