"""Run pi headless against a repo snapshot and parse its JSON event stream.

uv run python -m hindsight.runner.pi_runner --cwd <dir> --task "..." \
    --config hybrid_all_brief --repo FSM1/cipher-box --cutoff 2026-02-01T00:00:00Z
"""

import argparse
import json
import os
import subprocess
import time
from datetime import datetime, timezone

from hindsight.db import ROOT  # importing hindsight.db loads .env

PI_CLI = ROOT / "agent/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
EXTENSION = ROOT / "agent/extensions/hindsight-memory.ts"
NO_MEMORY_CONFIGS = {"repo_only", "oracle"}
READ_TOOLS = ["read", "grep", "find", "ls"]


def plan_prompt(cutoff: str | None) -> str:
    when = f"as of {cutoff[:10]}" if cutoff else "at its current state"
    return (
        "You are in plan mode. The repository in the working directory is checked out "
        f"{when}; treat that as today's date.\n"
        "Investigate with the read-only tools only, using at most about 12 tool calls.\n"
        "Then reply with a concrete plan for the task: numbered steps with the exact commands, "
        "files to change, and branch/commit names you would use. Do not ask questions. "
        "Keep the reply under 300 words."
    )


def build_command(task, *, use_memory, model, extra_system, cutoff) -> list[str]:
    tools = READ_TOOLS + (["search_memory"] if use_memory else [])
    cmd = [
        "node", str(PI_CLI),
        "-p", "--mode", "json", "--no-session", "--offline",
        "--provider", "openai", "--model", model, "--thinking", "low",
        "--tools", ",".join(tools),
        "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-approve",
        "--append-system-prompt", plan_prompt(cutoff),
    ]
    if extra_system:
        cmd += ["--append-system-prompt", extra_system]
    if use_memory:
        cmd += ["-e", str(EXTENSION)]
    return cmd + ["--", task]


def parse_events(lines: list[str]) -> dict:
    tool_calls, context_ids, errors = [], [], []
    response, model, cost, turns, used_memory = "", None, 0.0, 0, False
    for line in lines:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = ev.get("type")
        if kind == "tool_execution_start":
            tool_calls.append({"tool": ev.get("toolName"), "args": ev.get("args") or {}})
            used_memory |= ev.get("toolName") == "search_memory"
        elif kind == "tool_execution_end" and ev.get("toolName") == "search_memory":
            if not ev.get("isError"):
                context_ids += ((ev.get("result") or {}).get("details") or {}).get("ids") or []
            else:
                errors.append("search_memory failed")
        elif kind == "entry_appended":
            entry = ev.get("entry") or {}
            if entry.get("customType") == "hindsight_briefing":
                context_ids += (entry.get("data") or {}).get("ids") or []
        elif kind == "turn_end":
            turns += 1
        elif kind == "message_end":
            msg = ev.get("message") or {}
            if msg.get("role") != "assistant":
                continue
            cost += ((msg.get("usage") or {}).get("cost") or {}).get("total") or 0.0
            model = msg.get("model") or model
            text = "".join(c.get("text", "") for c in msg.get("content") or [] if c.get("type") == "text")
            if text.strip():
                response = text.strip()
            if msg.get("stopReason") == "error":
                errors.append(msg.get("errorMessage") or "assistant error")
        elif kind == "auto_retry_end" and not ev.get("success"):
            errors.append(ev.get("finalError") or "retry failed")
    return {
        "tool_calls": tool_calls,
        "used_memory_tool": used_memory,
        "context_ids": list(dict.fromkeys(context_ids)),
        "response": response,
        "cost_usd": round(cost, 6),
        "turns": turns,
        "model": model,
        "error": "; ".join(errors) or None,
    }


def iso(cutoff) -> str | None:
    if isinstance(cutoff, datetime):
        if cutoff.tzinfo is None:
            cutoff = cutoff.replace(tzinfo=timezone.utc)
        return cutoff.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return cutoff


def run_pi(snapshot_dir, task, *, config_id, repo_id=None, cutoff=None, model=None,
           api_base="http://127.0.0.1:8000", extra_system=None, timeout=240) -> dict:
    model = model or os.environ.get("PI_MODEL", "gpt-5.4-mini")
    cutoff = iso(cutoff)
    use_memory = config_id not in NO_MEMORY_CONFIGS
    if use_memory and not (repo_id and cutoff):
        raise ValueError(f"config {config_id} needs repo_id and cutoff")

    env = {k: v for k, v in os.environ.items() if not k.startswith("HINDSIGHT_")}
    if use_memory:
        env.update(HINDSIGHT_API=api_base, HINDSIGHT_REPO=repo_id,
                   HINDSIGHT_CUTOFF=cutoff, HINDSIGHT_CONFIG=config_id)

    cmd = build_command(task, use_memory=use_memory, model=model,
                        extra_system=extra_system, cutoff=cutoff)
    start = time.monotonic()
    proc = subprocess.Popen(cmd, cwd=snapshot_dir, env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    timed_out = False
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        out, err = proc.communicate()
        timed_out = True

    result = parse_events(out.decode("utf-8", "replace").split("\n"))
    result["duration_s"] = round(time.monotonic() - start, 1)
    result["model"] = result["model"] or model
    if timed_out:
        result["error"] = f"timeout after {timeout}s"
    elif proc.returncode != 0 and not result["error"]:
        tail = err.decode("utf-8", "replace").strip()[-500:]
        result["error"] = f"pi exited {proc.returncode}: {tail}"
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cwd", required=True)
    ap.add_argument("--task", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--repo")
    ap.add_argument("--cutoff")
    ap.add_argument("--model")
    ap.add_argument("--api", default="http://127.0.0.1:8000")
    ap.add_argument("--extra-system")
    ap.add_argument("--timeout", type=int, default=240)
    a = ap.parse_args()
    result = run_pi(a.cwd, a.task, config_id=a.config, repo_id=a.repo, cutoff=a.cutoff,
                    model=a.model, api_base=a.api, extra_system=a.extra_system, timeout=a.timeout)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
