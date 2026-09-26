import re

MAX_USER_CHARS = 1500
MIN_ASSISTANT_CHARS = 20

# Harness/skill markup that shows up inside "user" turns: notifications, slash-command
# expansions, shell passthrough, and fragments of skill prompt templates.
_TAGS = re.compile(
    r"</?(task-notification|system_instruction|system-reminder|command-[a-z-]+|local-command-[a-z-]+"
    r"|bash-(input|stdout|stderr)|objective|execution_context|step|offer_next|wave_execution"
    r"|success_criteria|planning_context|process|context|output)\b"
)
_PREFIXES = re.compile(
    r"^\s*(#|\*\*|\{|\[Request interrupted|\[Continue for|This session is being continued"
    r"|Tool loaded\.|Implement the following plan|Verify each finding against the current code)"
)


def is_noise(role: str, text: str) -> bool:
    text = text or ""
    if role == "assistant":
        return len(text.strip()) < MIN_ASSISTANT_CHARS
    if not text.strip() or len(text) > MAX_USER_CHARS:
        return True
    return bool(_TAGS.search(text) or _PREFIXES.match(text))
