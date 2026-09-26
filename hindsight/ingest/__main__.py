import argparse
import random

from hindsight.ingest.core import load, run


def sample_noise(repo_id: str, n: int = 10) -> None:
    _, turns = load(repo_id)
    users = [t for t in turns if t["role"] == "user"]
    rng = random.Random(0)
    for flag in (True, False):
        pool = [t for t in users if t["noise"] == flag]
        print(f"\n--- {'noise' if flag else 'kept'} user turns ({len(pool)}) ---")
        for t in rng.sample(pool, min(n, len(pool))):
            print(f"[{t['pushback'] or '-'}] {t['text'][:160]!r}")


def main() -> None:
    p = argparse.ArgumentParser(prog="python -m hindsight.ingest")
    p.add_argument("--repo", required=True, help="repo_id, e.g. FSM1/cipher-box")
    p.add_argument("--no-embed", action="store_true")
    p.add_argument("--sample", action="store_true", help="print noise samples and exit")
    args = p.parse_args()
    if args.sample:
        sample_noise(args.repo)
    else:
        run(args.repo, do_embed=not args.no_embed)


if __name__ == "__main__":
    main()
