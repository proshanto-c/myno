"""
Dalīl — the one call to Claude.

Raw HTTP, as the patient backend does it: the Messages API over httpx, no SDK.
Two things are worth saying about the shape of the call.

**It is forced through a tool.** `tool_choice` names the tool, so the reply is a
validated object rather than prose containing JSON, and a model that would
otherwise write a paragraph of preamble has nowhere to put it.

**The system block is cached.** The rubric and the app's vocabulary are the same
for every paper in a batch, and they are most of the tokens; marking them
ephemeral means the second paper onward pays for the paper alone.

What comes back is not trusted. Every quote is searched for in the stored text
by `claims.verify`, and anything that cannot be found scores zero — which is
handled in `reports.py`, not here, because this module's only job is to make the
call and hand back what was said.
"""
from __future__ import annotations

import json
import os

import httpx

import prompts

MODEL = "claude-sonnet-4-6"
API = "https://api.anthropic.com/v1/messages"
VERSION = "2023-06-01"
MAX_TOKENS = 4000
TIMEOUT = 180.0

# Enough of a paper to appraise, and not so much that one call costs a batch.
# Quotes are verified against the whole stored text, so a truncated send only
# limits what the model can quote — never what we can check.
MAX_TEXT = 60_000


class ModelError(RuntimeError):
    pass


def vocabulary_block(fields: dict, labels: dict) -> str:
    """The app's own field list, rendered for the prompt. Fetched from its
    contract at call time, so a field added to record.py is available here
    without anybody editing a prompt."""
    by_category: dict = {}
    for key, category in fields.items():
        by_category.setdefault(category, []).append(f"{key} ({labels.get(key, key)})")
    lines = ["## The fields the app records", ""]
    for category, keys in by_category.items():
        lines.append(f"**{category}** — " + ", ".join(sorted(keys)))
    return "\n".join(lines)


def source_block(source: dict) -> str:
    bits = [f"Title: {source.get('title', '')}",
            f"Journal: {source.get('journal') or source.get('book_title') or '—'}",
            f"Year: {source.get('year') or '—'}",
            f"Publication types: {', '.join(source.get('pub_types') or []) or '—'}",
            f"MeSH: {', '.join((source.get('mesh') or [])[:20]) or '—'}"]
    text = (source.get("abstract") or "").strip()
    full = (source.get("fulltext") or "").strip()
    if full:
        # The abstract is already inside the full text for OA articles, so the
        # full text alone avoids handing the model the same sentences twice —
        # which is how a quote ends up ambiguous between two positions.
        text = full[:MAX_TEXT]
        if len(full) > MAX_TEXT:
            bits.append(f"(full text truncated at {MAX_TEXT:,} characters)")
    return "\n".join(bits) + "\n\n---\n\n" + text


def appraise(source: dict, fields: dict, labels: dict, *, http: httpx.Client | None = None,
             api_key: str = "", model: str = MODEL) -> dict:
    """One paper in, the model's half of the rubric out."""
    api_key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise ModelError("ANTHROPIC_API_KEY is not set")

    system = [
        # Cached: the rubric and the vocabulary are identical across a batch.
        {"type": "text", "text": prompts.APPRAISE_SYSTEM + "\n\n" + vocabulary_block(fields, labels),
         "cache_control": {"type": "ephemeral"}},
    ]
    body = {
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": system,
        "tools": [prompts.APPRAISE_TOOL],
        "tool_choice": {"type": "tool", "name": prompts.APPRAISE_TOOL["name"]},
        "messages": [{"role": "user", "content": source_block(source)}],
    }

    owns = http is None
    client = http or httpx.Client(timeout=TIMEOUT)
    try:
        reply = client.post(API, json=body, headers={
            "x-api-key": api_key, "anthropic-version": VERSION,
            "content-type": "application/json"})
    finally:
        if owns:
            client.close()

    if reply.status_code >= 400:
        raise ModelError(f"HTTP {reply.status_code}: {reply.text[:400]}")
    data = reply.json()

    block = next((b for b in data.get("content", []) if b.get("type") == "tool_use"), None)
    if block is None:
        raise ModelError(f"no tool call in the reply: {json.dumps(data)[:400]}")

    usage = data.get("usage", {})
    return {"out": block.get("input", {}), "model": data.get("model", model),
            "promptVersion": prompts.APPRAISE_VERSION,
            "promptHash": prompts.APPRAISE_HASH,
            "tokensIn": usage.get("input_tokens", 0) + usage.get("cache_read_input_tokens", 0),
            "tokensOut": usage.get("output_tokens", 0)}
