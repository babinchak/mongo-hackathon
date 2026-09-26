import argparse
import os
import time

from hindsight.snapshots import commit_at, ensure_clone, grep_snapshot, snapshot_sha


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m hindsight.snapshots")
    ap.add_argument("--repo", required=True, help="owner/name")
    ap.add_argument("--cutoff", required=True, help="ISO datetime, e.g. 2026-02-01T00:00:00Z")
    ap.add_argument("--grep", help="comma-separated keywords")
    ap.add_argument("--max-files", type=int, default=8)
    args = ap.parse_args()

    t0 = time.perf_counter()
    _, branch = ensure_clone(args.repo)
    t1 = time.perf_counter()
    sha, date = commit_at(args.repo, args.cutoff)
    path = snapshot_sha(args.repo, sha)
    t2 = time.perf_counter()
    n_files = sum(len(files) for _, _, files in os.walk(path))

    print(f"repo      {args.repo} ({branch})")
    print(f"commit    {sha}")
    print(f"date      {date.isoformat()}")
    print(f"path      {path}")
    print(f"files     {n_files}")
    print(f"timing    clone/fetch {t1 - t0:.2f}s, snapshot {t2 - t1:.2f}s")

    if args.grep:
        keywords = [k for k in args.grep.split(",") if k.strip()]
        for r in grep_snapshot(path, keywords, max_files=args.max_files):
            print(f"\n{r['path']}  hits={r['hits']}  keywords={r['keywords']}")
            for line in r["lines"]:
                print(f"    {line}")


if __name__ == "__main__":
    main()
