# Myno — full stack

A PCOS digital twin: voice-first tracking, a companion that asks personalized
questions and **speaks** its replies, a feature **blacklist**, personalised
associations, and a clinician dashboard. Everything runs in Docker.

```
                ┌─────────────────────────────────────────────┐
   Browser ─────┤  frontend (nginx)  /  →  /api  →  /asr        │
   (Myno UI)    └──────┬───────────────┬──────────────┬─────────┘
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

| Service | What it is | Port | GPU |
|---|---|---|---|
| `frontend` | React app behind nginx; proxies `/api`→backend, `/asr`→asr | 80 | — |
| `backend` | FastAPI: chat orchestration, DB, personalization, blacklist, TTS proxy | 8080 | — |
| `asr` | NeMo cache-aware streaming ASR (`nemotron-speech-streaming-en-0.6b`) | 8000 | ✓ |
| `tts` | NeMo FastPitch + HiFi-GAN text-to-speech | 8001 | ✓ |
| `db` | Postgres 16 | 5432 | — |

## Run it

On the A100 host (Docker + NVIDIA Container Toolkit + `docker login nvcr.io`):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up --build
```

First boot is slow: the NeMo images are large and download the ASR/TTS
checkpoints on startup. Then open `http://<host>/`.

> **Microphone needs TLS.** Browsers only grant mic access over https/wss. Put a
> reverse proxy with a cert in front (see `NeMo_A100_Deployment.md`), then in
> Myno's **Settings** set the ASR endpoint to `wss://<host>/asr` and the Backend
> URL to `/api`.

If you only have the two GPUs’ worth of memory on one card, ASR + TTS coexist
fine — each is well under 4 GB.

## How the requested pieces work

**TTS that speaks *and* shows text.** The backend `/tts` proxies the NeMo TTS
service. The frontend splits each reply into sentences, requests audio per
sentence, and plays them through a queue so speech starts almost immediately and
feels seamless. The exact text being spoken is always rendered in the chat / the
live caption in **Voice mode** — spoken and written content are the same string.
No TTS endpoint? It falls back to the browser's `speechSynthesis`.

**Asks personalized questions.** `/patients/{id}/chat` builds the system prompt
from the patient's profile, recent turns, tracked cycle stats, and their stored
**personal descriptors** (their own words for things like mood). It acknowledges
in their words, then asks one relevant next question.

**Learns the patient's words + adapts.** Each turn, Claude also returns any new
`descriptors` (e.g. `mood: "foggy and flat"`) and an `adapt` block (tone, length,
distress). The backend stores descriptors and merges `adapt` into the patient's
`adapt_state`, which is fed back next turn — so Myno gets gentler/briefer/more
detailed based on the person.

**Blacklist (feature blocking).** A patient can block topics in Settings (mood,
diet, hair/skin, weight, fertility, pain). Blocked topics are (a) hidden from the
daily tracker, (b) stripped from the prep checklist, and (c) hard-forbidden in the
chat system prompt — enforced client-side **and** again server-side from the
`blacklist` column, so the model never asks about or volunteers them.

## Database schema (created automatically by SQLAlchemy)

- `patients` — profile, `goals`, `integrations`, `blacklist` (jsonb), `adapt_state` (jsonb)
- `daily_logs` — one row per patient per day (period, pain, sugar, mood, energy, hair, etc.)
- `descriptors` — the patient's own phrasings: `(concept, phrase)`
- `turns` — full conversation history
- All foreign-keyed to `patients`, cascade delete.

## API surface (backend)

```
GET    /healthz
POST   /patients                 create
GET    /patients/{id}            read
PATCH  /patients/{id}            update
GET    /patients/{id}/logs       list daily logs
POST   /patients/{id}/logs       upsert a day
GET    /patients/{id}/blacklist  blocked features + catalogue
PUT    /patients/{id}/blacklist  set blocked features
GET    /patients/{id}/descriptors  learned vocabulary
POST   /patients/{id}/chat       {message} → {reply, learned, adapt}
POST   /tts                      {text} → audio/wav (proxies the TTS service)
```

## Demo without the GPU box

The frontend degrades gracefully: leave the endpoints blank in Settings and it
uses the browser's speech recognition + synthesis and calls Claude directly with
the API key field. Wire the real services when you're on the A100.

## Files

```
myno-stack/
  docker-compose.yml
  NeMo_A100_Deployment.md
  backend/    main.py  Dockerfile
  asr/        nemo_asr_server.py  Dockerfile
  tts/        nemo_tts_server.py  Dockerfile
  frontend/   src/App.jsx (Myno) + src/main.jsx + Vite scaffold + nginx.conf + Dockerfile
```

## Frontend notes

- **One responsive build.** ≥1024px shows the **website view** (top navigation +
  wide two-column dashboards); narrower shows the **mobile view** (Serene Care
  with the bottom tab bar). It switches on resize.
- **Persistence.** The app reads/writes a key-value `window.storage`. In this
  standalone build, `src/main.jsx` shims it with `localStorage`, so a patient's
  profile, logs, and settings persist on the device.
- **Endpoints.** In **Settings**, set Backend URL to `/api` and the ASR endpoint
  to `wss://<host>/asr` (both proxied by nginx). Leave blank to demo with browser
  speech + direct Claude.

