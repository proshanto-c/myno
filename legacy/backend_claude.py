"""
RETIRED — the patient app's Anthropic client.

This is how Tawaazun talked to a model before the move to Google: one cached,
de-duplicated call, used by the conversational turn, the live-trends panel, the
Insights narration and the advocacy report. All four now go through
`backend/google_ai.py`; hearing and answering out loud go through the Live
session in `backend/live.py`.

Kept because the caching and single-flight rules here are the ones google_ai.py
inherited, and because Dalil — the research service, still on Claude Opus 5 —
has its own client that looks a great deal like this one. Nothing imports this
file.
"""
import asyncio, datetime as dt, hashlib, json, os
from collections import OrderedDict

import httpx
from fastapi import HTTPException

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = "claude-sonnet-4-6"
FAST_MODEL = os.environ.get("FAST_MODEL", "claude-haiku-4-5")

# ------------------------------------------------------- the Claude call
# A reply is a pure function of (model, system, messages, max_tokens), and the
# payload already carries everything patient-specific, so identical asks — the
# same person reopening Insights, a poll that fires twice, a re-rendered tab —
# are answered from memory instead of paying for the call again. Concurrent
# identical asks share a single in-flight request rather than racing.
CACHE_TTL = dt.timedelta(minutes=30)
CACHE_MAX = 512                 # ~ a few MB of replies; oldest evicted first
_cache: "OrderedDict[str, tuple]" = OrderedDict()
_inflight: dict = {}

def _cache_stats():
    return {"entries": len(_cache), "inflight": len(_inflight)}

async def claude(system: str, messages: list, max_tokens=900, model: str = None, on_text=None) -> str:
    """One answer from Claude, cached and de-duplicated.

    `on_text` is called with the running text as it streams. It is how the
    conversational turn gets a head start: the reply sentence comes first in the
    JSON we ask for, so it can be handed to the voice while the rest of the
    fields are still being written.
    """
    if not ANTHROPIC_API_KEY:
        raise HTTPException(500, "ANTHROPIC_API_KEY not configured")
    headers = {"x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01",
               "content-type": "application/json"}
    # top-level cache_control auto-caches the last cacheable block, so the whole
    # tools -> system -> messages prefix is reused on repeat calls (5 min TTL)
    payload = {"model": model or ANTHROPIC_MODEL, "max_tokens": max_tokens, "system": system,
               "messages": messages, "cache_control": {"type": "ephemeral"}}
    key = hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()

    now = dt.datetime.utcnow()
    hit = _cache.get(key)
    if hit and hit[0] > now:
        _cache.move_to_end(key)         # keep hot answers away from eviction
        return hit[1]
    _cache.pop(key, None)               # expired

    async def _stream() -> str:
        """The same request, read as it is written."""
        text = ""
        async with http().stream("POST", "https://api.anthropic.com/v1/messages",
                                 headers=headers, json={**payload, "stream": True}) as r:
            if r.status_code >= 400:
                await r.aread()
                try: why = r.json().get("error", {}).get("message", "")
                except Exception: why = ""
                raise HTTPException(502, f"Claude API {r.status_code}: {why or ''}")
            async for line in r.aiter_lines():
                if not line.startswith("data:"):
                    continue
                try: ev = json.loads(line[5:].strip())
                except Exception: continue
                if ev.get("type") == "content_block_delta":
                    piece = (ev.get("delta") or {}).get("text") or ""
                    if piece:
                        text += piece
                        try: on_text(text)
                        except Exception: pass          # a listener is never worth the answer
        return text.strip()

    async def _ask() -> str:
        if on_text is not None:
            text = await _stream()
            _cache[key] = (dt.datetime.utcnow() + CACHE_TTL, text)
            _cache.move_to_end(key)
            while len(_cache) > CACHE_MAX:
                _cache.popitem(last=False)
            return text
        try:
            r = await http().post("https://api.anthropic.com/v1/messages", headers=headers, json=payload)
        except httpx.HTTPError as e:
            raise HTTPException(502, f"Couldn't reach the Claude API: {e}")
        if r.status_code >= 400:
            # Surface Claude's own reason (bad key, low credit balance, rate limit)
            # instead of a bare status code — it lands in the log and in the UI.
            try: why = r.json().get("error", {}).get("message", "")
            except Exception: why = ""
            raise HTTPException(502, f"Claude API {r.status_code}: {why or r.text[:200]}")
        data = r.json()
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
        # only successful replies are cached; errors stay retryable
        _cache[key] = (dt.datetime.utcnow() + CACHE_TTL, text)
        _cache.move_to_end(key)
        while len(_cache) > CACHE_MAX:
            _cache.popitem(last=False)
        return text

    # One request per identical ask, however many callers are waiting. Shielded
    # so a caller who navigates away doesn't cancel the answer the others are
    # still waiting for; the task is tracked, so shutdown can end it.
    task = _inflight.get(key)
    if task is None or task.done():
        task = track(_ask())
        _inflight[key] = task
    try:
        return await asyncio.shield(task)
    finally:
        if _inflight.get(key) is task and task.done():
            _inflight.pop(key, None)

