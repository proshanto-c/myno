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


class TTSEngine:
    def __init__(self):
        log.info(f"Loading FastPitch + HiFi-GAN on {DEVICE} ...")
        self.spec = FastPitchModel.from_pretrained("tts_en_fastpitch").to(DEVICE).eval()
        self.vocoder = HifiGanModel.from_pretrained("tts_en_lj_hifigan_ft_mixertts").to(DEVICE).eval()

    @torch.no_grad()
    def synth(self, text: str) -> np.ndarray:
        text = (text or "").strip()
        if not text:
            return np.zeros(1, dtype=np.float32)
        tokens = self.spec.parse(text)
        spectrogram = self.spec.generate_spectrogram(tokens=tokens)
        audio = self.vocoder.convert_spectrogram_to_audio(spec=spectrogram)
        return audio.to("cpu").numpy().squeeze()


engine: TTSEngine | None = None
app = FastAPI(title="Myno TTS")


@app.on_event("startup")
def _load():
    global engine
    engine = TTSEngine()


@app.get("/healthz")
def healthz():
    return {"status": "ok", "device": DEVICE, "sample_rate": SAMPLE_RATE}


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
