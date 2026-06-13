Here's the rewritten README, in a neutral third-person repo voice:

---

# Myno — Full-Stack PCOS Digital Twin

Myno is a voice-first PCOS tracking app with a personalized AI companion, clinician dashboard, and GPU-accelerated speech services. Everything runs in Docker.

```
                ┌─────────────────────────────────────────────┐
   Browser ─────┤  frontend (nginx)  /  →  /api  →  /asr      │
   (Myno UI)    └──────┬───────────────┬──────────────┬────────┘
                       │ /api          │ /asr (ws)    │ (audio)
                 ┌─────▼─────┐   ┌─────▼──────┐  ┌────▼─────┐
                 │  backend  │   │    asr     │  │   tts    │
                 │ (FastAPI) │   │ NeMo strm  │  │ NeMo F.P.│
                 │  Claude   │   │  (GPU)     │  │  (GPU)   │
                 └─────┬─────┘   └────────────┘  └──────────┘
                       │ TTS_URL → tts,  Claude → api.anthropic.com
                 ┌─────▼─────┐
                 │ Postgres  │  patients · logs · descriptors · blacklist · turns
                 └───────────┘
```

| Service | Description | Port | GPU |
|---|---|---|---|
| `frontend` | React app behind nginx; proxies `/api` → backend, `/asr` → asr | 80 | — |
| `backend` | FastAPI: chat orchestration, DB, personalization, blacklist, TTS proxy | 8080 | — |
| `asr` | NeMo cache-aware streaming ASR (`nemotron-speech-streaming-en-0.6b`) | 8000 | ✓ |
| `tts` | NeMo FastPitch + HiFi-GAN text-to-speech | 8001 | ✓ |
| `db` | Postgres 16 | 5432 | — |

---

## Getting started

**Requirements:** Docker, NVIDIA Container Toolkit, and `docker login nvcr.io` on the A100 host.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up --build
```

First boot is slow — the NeMo images are large and download ASR/TTS checkpoints on startup. Then open `http://<host>/`.

> **Microphone requires TLS.** Browsers only grant mic access over HTTPS/WSS. Put a reverse proxy with a certificate in front (see `NeMo_A100_Deployment.md`), then in Myno's **Settings** set the ASR endpoint to `wss://<host>/asr` and the Backend URL to `/api`.

ASR and TTS coexist on a single card — each uses well under 4 GB of VRAM.

---

## Features

### Spoken + written replies in sync
The backend `/tts` endpoint proxies the NeMo TTS service. The frontend splits each reply into sentences, requests audio per sentence, and plays them through a queue so speech starts almost immediately. The exact text being spoken is rendered in the chat bubble and as a live caption in **Voice mode** — the spoken and written content are always the same string. If no TTS endpoint is configured, the app falls back to the browser's `speechSynthesis`.

### Personalized questions
`/patients/{id}/chat` builds the system prompt from the patient's profile, recent turns, tracked cycle stats, and stored **personal descriptors** — the patient's own words for symptoms and moods. Each turn, the companion acknowledges what was shared and asks one relevant follow-up question.

### Adaptive language learning
Each Claude response includes a `descriptors` block (e.g. `mood: "foggy and flat"`) and an `adapt` block (tone, length, distress level). The backend stores descriptors and merges `adapt` into `adapt_state`, which is fed back into the next turn's system prompt. Over time, Myno adjusts to be gentler, briefer, or more detailed based on the patient's cues.

### Feature blacklist
Patients can block topics in Settings (mood, diet, hair/skin, weight, fertility, pain). Blocked topics are hidden from the daily tracker, stripped from the prep checklist, and hard-forbidden in the chat system prompt. The blacklist is enforced both client-side and server-side from the `blacklist` DB column — the model never asks about or volunteers blocked subjects.

---

## Database schema

Tables are created automatically by SQLAlchemy.

| Table | Contents |
|---|---|
| `patients` | Profile, goals, integrations, `blacklist` (jsonb), `adapt_state` (jsonb) |
| `daily_logs` | One row per patient per day — period, pain, sugar, mood, energy, hair, etc. |
| `descriptors` | Patient vocabulary: `(concept, phrase)` pairs |
| `turns` | Full conversation history |

All tables foreign-key to `patients` with cascade delete.

---

## API reference

```
GET    /healthz
POST   /patients                    Create patient
GET    /patients/{id}               Get patient
PATCH  /patients/{id}               Update patient
GET    /patients/{id}/logs          List daily logs
POST   /patients/{id}/logs          Upsert a day's log
GET    /patients/{id}/blacklist     Get blocked features + catalogue
PUT    /patients/{id}/blacklist     Set blocked features
GET    /patients/{id}/descriptors   Get learned vocabulary
POST   /patients/{id}/chat          {message} → {reply, learned, adapt}
POST   /tts                         {text} → audio/wav (proxies TTS service)
```

---

## Demo without a GPU

Leave the ASR and Backend URL fields blank in **Settings** and the app uses the browser's built-in speech recognition and synthesis, calling Claude directly with an API key entered in the settings panel. Wire up the real services when running on the A100.

---

## Repository layout

```
myno-stack/
  docker-compose.yml
  NeMo_A100_Deployment.md
  backend/    main.py  Dockerfile
  asr/        nemo_asr_server.py  Dockerfile
  tts/        nemo_tts_server.py  Dockerfile
  frontend/   src/App.jsx  src/main.jsx  nginx.conf  Dockerfile
```

### Frontend notes

- **Responsive layout.** Viewports ≥ 1024 px render a website view with top navigation and wide two-column dashboards. Narrower viewports switch to a mobile view with a bottom tab bar. The layout updates on resize.
- **Persistence.** The app reads and writes via `window.storage`. In the standalone build, `src/main.jsx` shims this with `localStorage`, so a patient's profile, logs, and settings persist on the device.
- **Endpoint configuration.** In **Settings**, set Backend URL to `/api` and the ASR endpoint to `wss://<host>/asr` (both proxied by nginx). Leave blank to demo with browser speech and direct Claude access.
