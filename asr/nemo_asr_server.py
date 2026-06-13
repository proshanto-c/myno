"""
nemo_asr_server.py
==================
Real-time streaming ASR WebSocket server for NVIDIA Nemotron-Speech-Streaming
(nvidia/nemotron-speech-streaming-en-0.6b) — a Cache-Aware FastConformer-RNNT.

Unlike the buffered approach in the team's tutorial notebook (which re-runs the
encoder over overlapping windows), this uses NeMo's *cache-aware* streaming:
the encoder keeps per-layer attention/conv caches between chunks, so every audio
frame is processed exactly once. That's what makes it cheap enough to run many
concurrent voice sessions on one A100.

The browser captures mic audio, downsamples to 16 kHz mono PCM16, and streams
~1.12 s chunks over a WebSocket. We decode each chunk with conformer_stream_step,
keep the cache, and push partial/final transcripts back.

Endpoints
---------
GET  /healthz            -> {"status": "ok", "model": ...}
WS   /asr                -> bidirectional stream:
        client -> server : raw PCM16LE bytes (16 kHz mono), or a JSON control
                            frame {"type": "end"} to flush/finalize.
        server -> client : JSON {"type": "partial"|"final", "text": "...",
                                  "is_final": bool}

NOTE on NeMo versions: method names for cache-aware streaming have been stable
across recent releases, but verify against your installed NeMo (25.11) and the
canonical example you already have access to:
  NeMo/examples/asr/asr_cache_aware_streaming/speech_to_text_cache_aware_streaming_infer.py
If a signature differs, mirror that script — the buffering/cache logic here
follows it directly.
"""

import asyncio
import json
import logging
from contextlib import asynccontextmanager

import numpy as np
import torch
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

import nemo.collections.asr as nemo_asr

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("nemo-asr")

MODEL_NAME = "nvidia/nemotron-speech-streaming-en-0.6b"
SAMPLE_RATE = 16000

# Latency / accuracy operating point. att_context_size = [left, right] in 80ms frames.
#   [70, 0]  -> 0.08 s chunks (lowest latency, ~8.4% WER)
#   [70, 1]  -> 0.16 s
#   [70, 6]  -> 0.56 s
#   [70, 13] -> 1.12 s chunks (best accuracy, ~6.9% WER)  <- good default for a chatbot
ATT_CONTEXT_SIZE = [70, 13]

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# ---------------------------------------------------------------------------
# Model load (once, at startup) + a small holder for streaming geometry.
# ---------------------------------------------------------------------------
class ASREngine:
    def __init__(self):
        log.info(f"Loading {MODEL_NAME} on {DEVICE} ...")
        self.model = nemo_asr.models.ASRModel.from_pretrained(model_name=MODEL_NAME)
        self.model.to(DEVICE).eval()

        # Pick the streaming operating point.
        self.model.encoder.set_default_att_context_size(ATT_CONTEXT_SIZE)
        self.model.encoder.setup_streaming_params()

        # Use greedy RNNT decoding for low-latency streaming.
        try:
            self.model.change_decoding_strategy(decoder_type="rnnt")
        except Exception:
            pass

        # How many audio samples make up one streaming step.
        # 80 ms per frame * (right_context + 1) frames -> chunk length in seconds.
        self.chunk_frames = ATT_CONTEXT_SIZE[1] + 1            # e.g. 14 frames
        self.chunk_secs = self.chunk_frames * 0.08             # e.g. 1.12 s
        self.chunk_samples = int(self.chunk_secs * SAMPLE_RATE)  # e.g. 17920
        # Pre-encode frames to discard at the very first step (warmup padding).
        self.pre_encode_cache_size = self.model.encoder.streaming_cfg.pre_encode_cache_size[1]
        log.info(f"Streaming chunk: {self.chunk_secs:.2f}s ({self.chunk_samples} samples)")

    def fresh_cache(self):
        """Initial per-connection encoder cache + decoder state."""
        c_chan, c_time, c_chan_len = self.model.encoder.get_initial_cache_state(batch_size=1)
        return {
            "cache_last_channel": c_chan,
            "cache_last_time": c_time,
            "cache_last_channel_len": c_chan_len,
            "previous_hypotheses": None,
            "pred_out_stream": None,
        }

    @torch.no_grad()
    def step(self, audio_chunk: np.ndarray, state: dict, is_last: bool):
        """Run one cache-aware streaming step over a chunk of float32 mono audio."""
        sig = torch.tensor(audio_chunk, dtype=torch.float32, device=DEVICE).unsqueeze(0)
        sig_len = torch.tensor([sig.shape[1]], dtype=torch.long, device=DEVICE)

        # Mel features (NeMo expects raw waveform here; preprocessor handles framing).
        processed, processed_len = self.model.preprocessor(
            input_signal=sig, length=sig_len
        )

        (
            pred_out_stream,
            transcribed_texts,
            cache_last_channel,
            cache_last_time,
            cache_last_channel_len,
            previous_hypotheses,
        ) = self.model.conformer_stream_step(
            processed_signal=processed,
            processed_signal_length=processed_len,
            cache_last_channel=state["cache_last_channel"],
            cache_last_time=state["cache_last_time"],
            cache_last_channel_len=state["cache_last_channel_len"],
            keep_all_outputs=is_last,
            previous_hypotheses=state["previous_hypotheses"],
            previous_pred_out=state["pred_out_stream"],
            drop_extra_pre_encoded=None,
            return_transcription=True,
        )

        state.update(
            cache_last_channel=cache_last_channel,
            cache_last_time=cache_last_time,
            cache_last_channel_len=cache_last_channel_len,
            previous_hypotheses=previous_hypotheses,
            pred_out_stream=pred_out_stream,
        )

        text = ""
        if transcribed_texts and len(transcribed_texts) > 0:
            t = transcribed_texts[0]
            text = t.text if hasattr(t, "text") else str(t)
        return text


engine: ASREngine | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global engine
    engine = ASREngine()
    yield
    engine = None


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # tighten to your frontend origin in production
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz")
def healthz():
    return {"status": "ok", "model": MODEL_NAME, "device": DEVICE,
            "att_context_size": ATT_CONTEXT_SIZE}


@app.websocket("/asr")
async def asr_socket(ws: WebSocket):
    await ws.accept()
    assert engine is not None
    state = engine.fresh_cache()
    pcm_buffer = bytearray()
    last_text = ""
    log.info("client connected")

    async def decode_and_send(chunk_f32: np.ndarray, is_last: bool):
        nonlocal last_text
        # NeMo calls are blocking/GPU-bound; run off the event loop.
        text = await asyncio.to_thread(engine.step, chunk_f32, state, is_last)
        if text and text != last_text:
            last_text = text
            await ws.send_text(json.dumps(
                {"type": "final" if is_last else "partial",
                 "text": text, "is_final": is_last}))

    try:
        while True:
            msg = await ws.receive()

            if msg.get("type") == "websocket.disconnect":
                break

            # Control frame (JSON) -> flush remaining audio and finalize.
            if msg.get("text") is not None:
                try:
                    ctrl = json.loads(msg["text"])
                except json.JSONDecodeError:
                    continue
                if ctrl.get("type") == "end":
                    if pcm_buffer:
                        chunk = np.frombuffer(bytes(pcm_buffer), dtype=np.int16)
                        pcm_buffer.clear()
                        await decode_and_send(chunk.astype(np.float32) / 32768.0, is_last=True)
                    await ws.send_text(json.dumps({"type": "final", "text": last_text, "is_final": True}))
                    state = engine.fresh_cache()
                    last_text = ""
                continue

            # Binary frame -> raw PCM16LE @ 16 kHz mono.
            data = msg.get("bytes")
            if not data:
                continue
            pcm_buffer.extend(data)

            # Emit whole streaming chunks as they fill (2 bytes per sample).
            need = engine.chunk_samples * 2
            while len(pcm_buffer) >= need:
                raw = bytes(pcm_buffer[:need])
                del pcm_buffer[:need]
                chunk = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                await decode_and_send(chunk, is_last=False)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("stream error")
        try:
            await ws.send_text(json.dumps({"type": "error", "message": str(e)}))
        except Exception:
            pass
    finally:
        log.info("client disconnected")


if __name__ == "__main__":
    import uvicorn
    # One worker: the model lives in GPU memory and is shared across async
    # connections. Scale with more GPUs / replicas behind a load balancer.
    uvicorn.run("nemo_asr_server:app", host="0.0.0.0", port=8000, workers=1)
