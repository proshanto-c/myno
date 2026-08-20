# Deploying the GPU models on your A100

`asr` runs `nvidia/nemotron-speech-streaming-en-0.6b` — a **Cache-Aware
FastConformer-RNNT** that keeps per-layer encoder caches between chunks (no
overlapping recompute), so one A100 serves many concurrent voice streams. `tts`
runs NeMo **FastPitch + HiFi-GAN**. Both are pulled and run by `docker compose`.

You have two routes. **A** (this repo's NeMo servers) gives full control and
matches your existing notebook tooling. **B** (NVIDIA NIM containers) is the
fastest path to a hardened, managed endpoint — keep it for the deployment slide.

---

## Quick start (the whole stack)

On the A100 host with Docker, the **NVIDIA Container Toolkit**, and an NGC login
(`docker login nvcr.io`, needed for the NeMo base image):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up --build
```

First boot is slow — the NeMo images are large and the ASR/TTS checkpoints
download on startup. Then open `http://<host>/`.

> **Microphone needs TLS.** Browsers only grant mic access over https/wss. Put a
> reverse proxy with a cert in front, then in Myno **Settings** set the ASR
> endpoint to `wss://<host>/asr` and the Backend URL to `/api`.

---

## Latency / accuracy knob (ASR)

`att_context_size` in `asr/nemo_asr_server.py` (frames are 80 ms):

| `att_context_size` | Chunk | ~Avg WER | Feel |
|---|---|---|---|
| `[70, 0]`  | 0.08 s | 8.4% | snappiest |
| `[70, 1]`  | 0.16 s | 7.7% | |
| `[70, 6]`  | 0.56 s | 7.1% | |
| `[70, 13]` | 1.12 s | 6.9% | **default** — best words |

For a reflective symptom-logging chat, `[70, 13]` is the right call.

The cache-aware streaming loop uses `conformer_stream_step` with persistent
cache state per WebSocket connection. The source of truth for that loop is
NVIDIA's example — diff against it if a NeMo version shifts a signature:
`NeMo/examples/asr/asr_cache_aware_streaming/speech_to_text_cache_aware_streaming_infer.py`.

---

## Running ASR/TTS by hand (without compose)

```bash
sudo apt-get update && sudo apt-get install -y libsndfile1 ffmpeg
pip install Cython packaging
pip install "nemo_toolkit[asr]" @ git+https://github.com/NVIDIA/NeMo.git@main
pip install fastapi "uvicorn[standard]" soundfile numpy

python asr/nemo_asr_server.py     # ws://0.0.0.0:8000/asr
python tts/nemo_tts_server.py     # http://0.0.0.0:8001/tts
```

Health checks:

```bash
curl http://localhost:8000/healthz   # asr
curl http://localhost:8001/healthz   # tts
```

Keep them alive in production with systemd or `restart: always` (compose already
sets sensible defaults), and pin the NeMo image tag once verified.

---

## Path B — NVIDIA NIM (fastest to a managed endpoint)

```bash
docker login nvcr.io
export NGC_API_KEY=<your-key>
docker run --rm --gpus all -e NGC_API_KEY -p 9000:9000 \
  nvcr.io/nim/nvidia/nemotron-asr-streaming:latest
```

See `https://build.nvidia.com/nvidia/nemotron-asr-streaming` for the exact tag.
Put a thin WebSocket shim (same protocol as `asr`) in front so the frontend
doesn't change. There's also a maintained Modal deployment and a Pipecat
voice-agent example wiring this model into a full duplex agent.

---

## How the browser connects

1. `getUserMedia` → mic.
2. Downsample to **16 kHz mono PCM16**, stream binary frames to `/asr`.
3. Render `partial` transcripts live; commit on `final`; send `{"type":"end"}`.
4. Committed text → Claude (via the backend) → reply text + structured extraction.
5. Reply text → `/tts` (backend proxy → NeMo) → audio played while the same text
   is shown on screen.

No endpoints set? The frontend falls back to the browser's built-in speech
recognition + synthesis and calls Claude directly with the key in Settings — so
the UI demos without the A100 in the loop.
