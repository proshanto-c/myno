"""
Google AI: everything the app works out, says, or hears.

It replaced three pipelines with one provider. What used to be a NeMo socket
for hearing, a small Anthropic model for the conversational turn, and a cloning
TTS service for the answer is now Gemini — text through `ask`, and speech in
both directions through the Live API (see live.py).

Two things are deliberately NOT here:

  * Dalīl, the research service, stays on Claude Opus 5. It reads papers and
    argues about evidence, which is a different job from this one.
  * The guide's voice is still the cloned one. Gemini speaks in prebuilt voices
    and cannot be somebody in particular, and the demo is somebody in
    particular.

The cache and the single-flight are the same rules the Anthropic client used to
keep: identical asks share one request, answers are held for half an hour, and
only successes are kept, so an error stays retryable.
"""
import os, json, asyncio, hashlib, datetime as dt
from collections import OrderedDict
from typing import Optional

from google import genai
from google.genai import types

GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "")

# A turn in a conversation — short in, short out, somebody waiting on it.
FAST_MODEL = os.environ.get("GOOGLE_FAST_MODEL", "gemini-3.5-flash")
# The analyses: a page of numbers in, a considered paragraph out. Nobody watches
# these being written, so they can afford to think.
DEEP_MODEL = os.environ.get("GOOGLE_DEEP_MODEL", "gemini-3.5-flash")
# Hearing and answering out loud, in one session.
LIVE_MODEL = os.environ.get("GOOGLE_LIVE_MODEL", "gemini-2.5-flash-native-audio-latest")

CACHE_TTL = dt.timedelta(minutes=30)
CACHE_MAX = 512
_cache: "OrderedDict[str, tuple]" = OrderedDict()
_inflight: dict = {}
_tasks: "set[asyncio.Task]" = set()

_client: Optional[genai.Client] = None


def client() -> genai.Client:
    global _client
    if _client is None:
        if not GOOGLE_API_KEY:
            raise RuntimeError("GOOGLE_API_KEY is not configured")
        _client = genai.Client(api_key=GOOGLE_API_KEY)
    return _client


def configured() -> bool:
    return bool(GOOGLE_API_KEY)


def cache_stats() -> dict:
    return {"entries": len(_cache), "inflight": len(_inflight)}


def _track(coro) -> asyncio.Task:
    task = asyncio.create_task(coro)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return task


async def ask(system: str, user: str, *, model: str = None, max_tokens: int = 900,
              want_json: bool = True, temperature: float = 0.4, think: str = "minimal",
              on_text=None) -> str:
    """One answer, as text.

    `think` is the thing to get right here. These models reason before they
    answer, and those tokens come out of `max_output_tokens` — so a budget
    sized for a model that did not think returns an empty string: the whole
    allowance spent reasoning about a form, with nothing left to fill it in.
    Filling in fields from one sentence needs no reasoning at all, and
    "minimal" is both the right answer and a second off the wait. The long
    analyses ask for "low" and are given room.

    `on_text` is called with the running text as it arrives, which is how the
    conversational turn gets a head start: the reply sentence is written first,
    so it can be handed to the voice while the rest of the fields are still
    being filled in.
    """
    model = model or FAST_MODEL
    key = hashlib.sha256(json.dumps(
        [model, system, user, max_tokens, want_json, temperature, think], sort_keys=True).encode()).hexdigest()

    now = dt.datetime.utcnow()
    hit = _cache.get(key)
    if hit and hit[0] > now:
        _cache.move_to_end(key)
        if on_text:
            try: on_text(hit[1])          # a cached answer is still an answer to act on
            except Exception: pass
        return hit[1]
    _cache.pop(key, None)

    config = types.GenerateContentConfig(
        system_instruction=system,
        max_output_tokens=max_tokens,
        temperature=temperature,
        **({"thinking_config": types.ThinkingConfig(thinking_level=think)} if think else {}),
        **({"response_mime_type": "application/json"} if want_json else {}),
    )

    def _keep(text: str) -> str:
        text = (text or "").strip()
        if text:
            _cache[key] = (dt.datetime.utcnow() + CACHE_TTL, text)
            _cache.move_to_end(key)
            while len(_cache) > CACHE_MAX:
                _cache.popitem(last=False)
        return text

    async def _once() -> str:
        if on_text is None:
            r = await client().aio.models.generate_content(model=model, contents=user, config=config)
            return _keep(r.text)
        text = ""
        stream = await client().aio.models.generate_content_stream(
            model=model, contents=user, config=config)
        async for chunk in stream:
            piece = getattr(chunk, "text", None)
            if not piece:
                continue
            text += piece
            try: on_text(text)
            except Exception: pass        # a listener is never worth the answer
        return _keep(text)

    # One request per identical ask, however many callers are waiting. Shielded,
    # so a caller who navigates away does not cancel the answer the others are
    # still waiting for.
    task = _inflight.get(key)
    if task is None or task.done():
        task = _track(_once())
        _inflight[key] = task
    try:
        return await asyncio.shield(task)
    finally:
        if _inflight.get(key) is task and task.done():
            _inflight.pop(key, None)


async def close():
    for task in list(_tasks):
        task.cancel()
