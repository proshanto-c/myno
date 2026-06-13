"""
nemo_tts_server.py
==================
Text-to-speech service for Myno. Synthesizes the assistant's replies so Myno can
speak to the patient. The frontend plays the audio AND shows the same text, so
the spoken and written content always match.

Pipeline: FastPitch (text -> mel spectrogram) -> HiFi-GAN (mel -> waveform).
Both are pretrained NeMo English models and run comfortably on the A100 alongside
the ASR model (each is small). Synthesis of a sentence is well under a second on
an A100, which is what makes the turn-taking feel seamless; for sentence-level
streaming we expose /tts per chunk and let the frontend queue playback.

For lower-latency production streaming, swap this for NVIDIA Riva TTS / a NIM
container — same HTTP contract, just point the backend's TTS_URL at it.

Endpoints:
  GET  /healthz
  POST /tts        body {"text": "..."}  ->  audio/wav (22.05 kHz mono)
"""
import io
import logging

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel

from nemo.collections.tts.models import FastPitchModel, HifiGanModel

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("myno-tts")

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
SAMPLE_RATE = 22050

# Softer, more natural voice. VITS (end-to-end) sounds far less robotic than
# FastPitch + HiFi-GAN, so we use it when available and fall back otherwise.
SOFT_PACE = 0.92    # < 1.0 = slower / gentler (FastPitch fallback only)
SOFT_GAIN = 0.9     # gentle loudness ease


def _soften(audio: np.ndarray) -> np.ndarray:
    audio = np.asarray(audio, dtype=np.float32).squeeze()
    if audio.size == 0:
        return audio
    peak = float(np.max(np.abs(audio))) or 1.0
    return (audio / peak * SOFT_GAIN).astype(np.float32)  # normalize, then ease


class TTSEngine:
    def __init__(self):
        self.kind = None
        try:
            from nemo.collections.tts.models import VitsModel
            log.info(f"Loading VITS (tts_en_lj_vits) on {DEVICE} ...")
            self.vits = VitsModel.from_pretrained("tts_en_lj_vits").to(DEVICE).eval()
            self.kind = "vits"
        except Exception as ex:
            log.warning(f"VITS unavailable ({ex}); falling back to FastPitch + HiFi-GAN")
            self.spec = FastPitchModel.from_pretrained("tts_en_fastpitch").to(DEVICE).eval()
            self.vocoder = HifiGanModel.from_pretrained("tts_en_lj_hifigan_ft_mixertts").to(DEVICE).eval()
            self.kind = "fastpitch"
        log.info(f"TTS engine ready: {self.kind}")

    @torch.no_grad()
    def synth(self, text: str) -> np.ndarray:
        text = (text or "").strip()
        if not text:
            return np.zeros(1, dtype=np.float32)
        if self.kind == "vits":
            tokens = self.vits.parse(text)
            audio = self.vits.convert_text_to_waveform(tokens=tokens)
        else:
            tokens = self.spec.parse(text)
            try:
                spectrogram = self.spec.generate_spectrogram(tokens=tokens, pace=SOFT_PACE)
            except TypeError:  # older signature without `pace`
                spectrogram = self.spec.generate_spectrogram(tokens=tokens)
            audio = self.vocoder.convert_spectrogram_to_audio(spec=spectrogram)
        return _soften(audio.to("cpu").numpy())


engine: TTSEngine | None = None
app = FastAPI(title="Myno TTS")


@app.on_event("startup")
def _load():
    global engine
    engine = TTSEngine()


@app.get("/healthz")
def healthz():
    return {"status": "ok", "device": DEVICE, "sample_rate": SAMPLE_RATE, "engine": getattr(engine, "kind", None)}


class TTSIn(BaseModel):
    text: str


@app.post("/tts")
def tts(body: TTSIn):
    audio = engine.synth(body.text)
    buf = io.BytesIO()
    sf.write(buf, audio, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return Response(content=buf.read(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("nemo_tts_server:app", host="0.0.0.0", port=8001, workers=1)
