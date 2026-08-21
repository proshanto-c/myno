"""
The conversation, in real time, over one connection.

What this replaces
------------------
Recording a day used to take three pipelines and four round trips: a streaming
ASR service to hear the words, a model call to understand them and write a
reply, and a speech service to say that reply out loud — each one waiting for
the one before it, six and a half seconds from the end of a sentence to the
start of an answer.

The Live API does all three at once, in a session that stays open: audio goes
up as it is spoken, the transcript comes back while the person is still
talking, and the answer arrives as audio the moment the model has decided on
it. Nothing waits for anything else.

The browser side did not have to change much: it was already sending 16 kHz
PCM16 over a WebSocket and reading JSON messages back, because that is what the
old ASR server wanted. So this speaks the same dialect —

    browser → here   binary frames of PCM16 @ 16 kHz
                     {"type":"end"}            end this turn now

    here → browser   {"type":"partial","text":…}   what it is hearing
                     {"type":"final","text":…}     what it heard, settled
                     {"type":"reply","text":…}     what it is saying back
                     {"type":"audio","pcm":…}      base64 PCM16 @ 24 kHz
                     {"type":"interrupted"}        stop playing; it was talked over
                     {"type":"error","message":…}

— which means the failure path is the old one too: if this cannot be reached,
the app falls back to whatever recogniser the browser has of its own.
"""
import asyncio, base64, json, logging, os

from fastapi import WebSocket, WebSocketDisconnect
from google.genai import types

import google_ai

log = logging.getLogger("myno.live")

# What it is doing here, and what it must not do. The fields are filled in by a
# separate structured call on the transcript — this one is the conversation.
PERSONA = (
    "You are Tawaazun, a gentle, caring companion for someone tracking symptoms of PMOS "
    "(polycystic morphology and ovulatory syndrome). Someone is telling you about their day out loud, "
    "often on a bad one.\n"
    "- Be warm and unhurried. Sound like somebody who is glad they told you.\n"
    "- Reply in ONE short spoken sentence, under 25 words. You are being listened to, not read.\n"
    "- Take in what they said before anything else, in their own words, and only then ask at most "
    "one gentle follow-up. Some days the right answer is just to acknowledge it.\n"
    "- Never brisk, never clinical, never cheerful at somebody who is in pain.\n"
    "- Never diagnose, never give drug doses, never suggest a treatment. A clinician decides.\n"
    "- Never invent what they did not say."
)

# The voice it says that in. Google's are prebuilt and named, and the names say
# what they sound like: Achernar is the soft one, and it was chosen by ear from
# a page of candidates all saying the same line. The gentle-sounding pick on
# paper (Vindemiatrix) turned out flat and synthetic out loud, which is the
# wrong thing to be when somebody is telling you about a bad day — hence
# listening to them, and hence this staying changeable without a rebuild.
#
# (The guide who narrates the demo is a real person's cloned voice, which is a
# different service and a different thing entirely.)
VOICE = os.environ.get("GOOGLE_LIVE_VOICE", "Achernar")

# WHOSE JOB IT IS TO NOTICE A PAUSE.
#
# The model's. It listens to the audio as it arrives and decides when a turn is
# over — which is why the microphone has to keep streaming through silences
# rather than stopping: silence is what it listens for. The client used to run
# its own timer and end the stream itself, which both fought this and left the
# session with nothing more to hear.
#
# Slow to call an end (END_SENSITIVITY_LOW, and over a second of quiet), quick
# to notice a start, because being cut off mid-sentence is the rudest thing a
# conversation can do to somebody describing their symptoms.
SILENCE_MS = int(os.environ.get("GOOGLE_LIVE_SILENCE_MS", "1200"))


def session_config(personality_note: str = "") -> dict:
    return {
        "response_modalities": ["AUDIO"],
        "input_audio_transcription": {},      # what they said
        "output_audio_transcription": {},     # what it said back, as text
        "speech_config": {
            "voice_config": {"prebuilt_voice_config": {"voice_name": VOICE}},
        },
        "realtime_input_config": {
            "automatic_activity_detection": {
                "start_of_speech_sensitivity": "START_SENSITIVITY_HIGH",
                "end_of_speech_sensitivity": "END_SENSITIVITY_LOW",
                "prefix_padding_ms": 150,
                "silence_duration_ms": SILENCE_MS,
            }
        },
        "system_instruction": PERSONA + (f"\nTone: {personality_note}" if personality_note else ""),
    }


async def bridge(ws: WebSocket, personality_note: str = ""):
    """One browser, one Live session, until either end goes away.

    Three things have to be true at once and none of them can be assumed:
    audio has to keep flowing up while the model is talking down, either side
    can vanish at any moment, and when one does the other has to be let go of
    rather than shouted at. The first version of this sent transcripts into a
    socket the browser had already closed, which ASGI rightly refuses.
    """
    await ws.accept()
    if not google_ai.configured():
        await ws.send_text(json.dumps({"type": "error", "message": "GOOGLE_API_KEY is not configured"}))
        await ws.close()
        return

    open_to_browser = True
    frames = bytes_in = 0

    async def tell(payload: dict) -> bool:
        """Say something to the browser, or notice that it has gone."""
        nonlocal open_to_browser
        if not open_to_browser:
            return False
        try:
            await ws.send_text(json.dumps(payload))
            return True
        except (WebSocketDisconnect, RuntimeError):
            open_to_browser = False       # it hung up; stop talking to it
            return False

    heard, spoken = [], []
    try:
        async with google_ai.client().aio.live.connect(
                model=google_ai.LIVE_MODEL, config=session_config(personality_note)) as session:
            log.info("live session open (model=%s)", google_ai.LIVE_MODEL)

            async def from_browser():
                """Microphone up. Binary is audio; text is a control frame."""
                nonlocal frames, bytes_in, open_to_browser
                while True:
                    msg = await ws.receive()
                    if msg.get("type") == "websocket.disconnect":
                        open_to_browser = False
                        return
                    data = msg.get("bytes")
                    if data:
                        frames += 1
                        bytes_in += len(data)
                        if frames == 1:
                            log.info("live: first audio frame (%d bytes)", len(data))
                        await session.send_realtime_input(
                            audio=types.Blob(data=data, mime_type="audio/pcm;rate=16000"))
                        continue
                    text = msg.get("text")
                    if not text:
                        continue
                    try: ctrl = json.loads(text)
                    except ValueError: continue
                    if ctrl.get("type") == "end":
                        # The client thinks the turn is over. The model does its
                        # own endpointing too; this is the person's vote.
                        await session.send_realtime_input(audio_stream_end=True)

            pump = asyncio.create_task(from_browser())
            # An audio pump that dies quietly is a microphone that does nothing,
            # with no sign of why — so its ending is always accounted for.
            def pump_done(task: asyncio.Task):
                if task.cancelled():
                    return
                err = task.exception()
                if err:
                    log.warning("live: the audio pump stopped: %r", err)
            pump.add_done_callback(pump_done)

            receiving = asyncio.create_task(_relay(session, tell, heard, spoken))
            # Whichever ends first ends the session: a browser that has gone, or
            # a model that has finished with us.
            done, pending = await asyncio.wait({pump, receiving}, return_when=asyncio.FIRST_COMPLETED)
            # Which of them ended is the whole diagnosis when a conversation
            # stops early: the person closed the app, or the model let go.
            log.info("live: ended by %s", "the browser" if pump in done else "the model")
            for task in pending:
                task.cancel()
            for task in done:
                if not task.cancelled() and task.exception():
                    raise task.exception()
    except WebSocketDisconnect:
        pass
    except Exception as e:                     # a session that dies is a session that ends
        log.warning("live session ended: %s", e)
        await tell({"type": "error", "message": str(e)[:200]})
    finally:
        log.info("live session closed after %d frames (%d bytes)", frames, bytes_in)
        if open_to_browser:
            try: await ws.close()
            except Exception: pass


async def _relay(session, tell, heard: list, spoken: list):
    """Everything the model says, on to the browser, for as long as it is said.

    ONE `receive()` IS ONE TURN. The SDK's iterator stops at `turn_complete` —
    it is written for a script that asks a question, reads the answer, and asks
    the next one. A conversation is not that shape: nobody says anything to
    start it, and it has to survive the first answer.

    Letting the iterator end was ending the session, and ending the session
    closed the socket while the browser still had seconds of that answer left
    to play — so the reply was cut off mid-word, every time, and there was no
    second turn to notice it with. So each pass is one turn, and the loop is
    what makes it a conversation.
    """
    while True:
        said_anything = False
        async for message in session.receive():
            said_anything = True
            if not await _one(message, tell, heard, spoken):
                return
        if not said_anything:
            return                     # the model let go of its end
        heard.clear()
        spoken.clear()


async def _one(message, tell, heard: list, spoken: list) -> bool:
    """One message on to the browser. False if the browser has gone."""
    content = getattr(message, "server_content", None)
    if not content:
        return True

    said = getattr(content, "input_transcription", None)
    if said and said.text:
        heard.append(said.text)
        if not await tell({"type": "partial", "text": "".join(heard).strip()}):
            return False

    reply = getattr(content, "output_transcription", None)
    if reply and reply.text:
        spoken.append(reply.text)
        if not await tell({"type": "reply", "text": "".join(spoken).strip()}):
            return False

    turn = getattr(content, "model_turn", None)
    if turn:
        for part in turn.parts or []:
            blob = getattr(part, "inline_data", None)
            if blob and blob.data:
                if not await tell({"type": "audio", "rate": 24000,
                                   "pcm": base64.b64encode(blob.data).decode()}):
                    return False

    if getattr(content, "interrupted", False):
        # Somebody spoke over it. The model has thrown away the rest of what it
        # was saying, so the browser has to throw away the rest of what it was
        # playing — otherwise the answer carries on out of a buffer for a few
        # seconds after being interrupted, which is the opposite of listening.
        log.info("live: interrupted mid-answer")
        if not await tell({"type": "interrupted"}):
            return False

    if getattr(content, "turn_complete", False):
        # The turn is over: hand up what was heard. The clearing happens in the
        # loop above, once this turn's last message has gone out.
        if not await tell({"type": "final", "text": "".join(heard).strip()}):
            return False
    return True
