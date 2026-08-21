# Retired

Nothing in here runs. It is kept because it explains what the app used to be,
and because a few of its ideas survived into what replaced it.

## What was here, and what replaced it

| Retired | What it did | What does it now |
|---|---|---|
| `asr/` | NeMo cache-aware streaming ASR (`nemotron-speech-streaming-en-0.6b`) on the GPU, over a WebSocket at `/asr`. Heard the words and nothing else — it had no idea when somebody had finished speaking, so the client had to tell it. | The Google **Live API** session held by the backend (`backend/live.py`), which hears, understands and answers in one connection, and does its own endpointing. |
| `tts/` | NeMo FastPitch + HiFi-GAN, a general-purpose voice for the app's spoken replies. | The Live session speaks its own replies. |
| `backend_claude.py` | The patient app's Anthropic client: one cached, de-duplicated call behind the conversational turn, the live-trends panel, the Insights narration and the advocacy report. | `backend/google_ai.py` — the same caching and single-flight rules, pointed at Gemini. |

## What did not move

**Dalīl still runs on Claude Opus 5.** Reading papers and arguing about the
strength of evidence is a different job from holding a conversation about
somebody's day, and it is not part of this migration.

**The guide's voice is still cloned.** Google speaks in prebuilt voices, and
prebuilt cannot be somebody in particular — the guided demo is narrated by a
named person from a recording of her, so the VoiceStudio service stays for that
one job. Everything else it used to do is gone.

## Why the sequence mattered

Three pipelines meant three waits, one after another: hear the sentence, ask a
model about it, then have a third service say the answer. Six and a half
seconds from the end of a sentence to the start of a reply, most of it spent
handing work between services that could not overlap. The Live session removes
the handovers rather than making each leg faster.
