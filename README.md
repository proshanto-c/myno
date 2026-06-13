# Myno — Full-Stack PCOS Digital Twin

Myno is a voice-first PCOS tracking app with a personalized AI companion, GPU-accelerated speech services, and a clinician dashboard. Everything runs in Docker.

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

## Deployment

### 1. System requirements

- **OS:** Linux (Ubuntu 22.04 LTS recommended)
- **GPU:** NVIDIA A100 (or any Ampere/Hopper card with ≥ 8 GB VRAM per GPU service; ASR and TTS each use well under 4 GB and coexist on a single card)
- **NVIDIA driver:** 525 or later (`nvidia-smi` to verify)
- **Docker:** 24.0 or later
- **Docker Compose:** v2 plugin (`docker compose version` to verify)
- **NVIDIA Container Toolkit** — so Docker can expose the GPU to containers
- **NGC account** — to pull the NeMo base image from `nvcr.io`
- **Anthropic API key** — Claude powers the chat backend

---

### 2. Install Docker

```bash
# Remove any old installations
sudo apt-get remove docker docker-engine docker.io containerd runc

# Install via the official convenience script
curl -fsSL https://get.docker.com | sudo sh

# Add your user to the docker group (log out and back in after this)
sudo usermod -aG docker $USER
```

Verify:

```bash
docker --version        # Docker version 24.x or later
docker compose version  # Docker Compose version v2.x or later
```

---

### 3. Install the NVIDIA Container Toolkit

```bash
# Add the NVIDIA apt repository
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit

# Configure the Docker runtime and restart Docker
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Verify GPU is visible inside Docker:

```bash
docker run --rm --gpus all nvidia/cuda:12.0-base-ubuntu22.04 nvidia-smi
```

---

### 4. Authenticate with NGC

The ASR and TTS services are built on `nvcr.io/nvidia/nemo:25.09`. You need an NGC account to pull it.

1. Create a free account at https://ngc.nvidia.com
2. Generate an API key: **Profile → Setup → Generate API Key**
3. Log in from the terminal:

```bash
docker login nvcr.io
# Username: $oauthtoken        (literal string, not your username)
# Password: <your NGC API key>
```

---

### 5. Clone the repository

```bash
git clone https://github.com/<your-org>/myno.git
cd myno
```

---

### 6. Set the Anthropic API key

The backend requires `ANTHROPIC_API_KEY` at runtime. Export it in your shell before running Compose:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Or write it to a `.env` file in the project root (never commit this file):

```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
```

Docker Compose picks up `.env` automatically. The key is injected only into the `backend` container and never exposed to the frontend.

---

### 7. Build and start all services

```bash
docker compose up --build
```

What happens on first boot:

1. Docker builds all five images. The `asr` and `tts` images are based on `nvcr.io/nvidia/nemo:25.09` (~20 GB) and take several minutes to pull the first time.
2. The `db` container starts Postgres and runs the health check. `backend` waits until the database is ready before starting.
3. The `asr` and `tts` containers download their model checkpoints from NGC on first launch (`nemotron-speech-streaming-en-0.6b` for ASR; FastPitch + HiFi-GAN for TTS). This happens once and is cached inside the container image layer — subsequent boots are fast.
4. The `frontend` container builds the React app with Vite and serves it behind nginx on port 80.

Once all services are up, open `http://<host>/` in a browser.

To run in detached mode:

```bash
docker compose up --build -d
```

Check service health:

```bash
docker compose ps
curl http://localhost:8080/healthz   # backend
curl http://localhost:8000/healthz   # asr
curl http://localhost:8001/healthz   # tts
```

---

### 8. Enable microphone access (TLS)

Browsers only grant microphone access over HTTPS/WSS. For voice input to work, you must put a TLS-terminating reverse proxy in front of the stack.

A minimal Caddy example (replace `myno.example.com` with your domain or server IP):

```bash
sudo apt-get install -y caddy

# /etc/caddy/Caddyfile
myno.example.com {
    reverse_proxy localhost:80
}
```

```bash
sudo systemctl reload caddy
```

Caddy provisions a Let's Encrypt certificate automatically.

For a self-signed certificate on a private network, or for a full nginx + certbot setup, see `NeMo_A100_Deployment.md`.

---

### 9. Configure endpoints in the app

Open the app in a browser and go to **Settings**:

| Setting | Value |
|---|---|
| Backend URL | `/api` |
| ASR endpoint | `wss://<your-domain>/asr` |

Both are proxied through nginx, so they always share the same origin as the frontend. Leave them blank to fall back to browser speech recognition and a direct Claude API call (see [Demo without a GPU](#demo-without-a-gpu)).

---

### 10. Stopping and restarting

```bash
# Stop all containers (data is preserved in the myno_db Docker volume)
docker compose down

# Stop and delete all data
docker compose down -v

# Restart a single service after a code change
docker compose up --build backend
```

---

## Demo without a GPU

The app degrades gracefully when the GPU services are unavailable:

1. Leave **Backend URL** and **ASR endpoint** blank in Settings.
2. Enter your Anthropic API key directly in the Settings panel.
3. The app uses the browser's built-in `SpeechRecognition` for input and `speechSynthesis` for output, and calls Claude directly from the client.

This mode works on any machine with a modern browser. Wire up the real services when running on the A100.

---

## Features

### Spoken + written replies in sync
The backend `/tts` endpoint proxies the NeMo TTS service. The frontend splits each reply into sentences, requests audio per sentence, and plays them through a queue so speech starts almost immediately. The exact text being spoken is rendered in the chat bubble and as a live caption in **Voice mode**. If no TTS endpoint is configured, the app falls back to the browser's `speechSynthesis`.

### Personalized questions
`/patients/{id}/chat` builds the system prompt from the patient's profile, recent turns, tracked cycle stats, and stored **personal descriptors** — the patient's own words for symptoms and moods. Each turn, the companion acknowledges what was shared and asks one relevant follow-up question.

### Adaptive language learning
Each Claude response includes a `descriptors` block (e.g. `mood: "foggy and flat"`) and an `adapt` block (tone, length, distress level). The backend stores descriptors and merges `adapt` into `adapt_state`, which is fed back into the next turn's system prompt. Over time, Myno adjusts its tone and detail level based on the patient's cues.

### Feature blacklist
Patients can block topics in Settings (mood, diet, hair/skin, weight, fertility, pain). Blocked topics are hidden from the daily tracker, stripped from the prep checklist, and hard-forbidden in the chat system prompt — enforced client-side and again server-side from the `blacklist` DB column.

---

## Database schema

Tables are created automatically by SQLAlchemy on first backend startup.

| Table | Contents |
|---|---|
| `patients` | Profile, goals, integrations, `blacklist` (jsonb), `adapt_state` (jsonb) |
| `daily_logs` | One row per patient per day — period, pain, sugar, mood, energy, hair, etc. |
| `descriptors` | Patient vocabulary: `(concept, phrase)` pairs |
| `turns` | Full conversation history |

All tables foreign-key to `patients` with cascade delete. Data is persisted in the `myno_db` Docker volume.

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

## Environment variables

| Variable | Service | Required | Default | Description |
|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | backend | ✓ | — | Anthropic API key for Claude |
| `DATABASE_URL` | backend | — | `postgresql+psycopg2://myno:myno@db:5432/myno` | Postgres connection string |
| `TTS_URL` | backend | — | `http://tts:8001` | Internal URL of the TTS service |
| `POSTGRES_USER` | db | — | `myno` | Postgres username |
| `POSTGRES_PASSWORD` | db | — | `myno` | Postgres password |
| `POSTGRES_DB` | db | — | `myno` | Postgres database name |

Change Postgres credentials by editing `docker-compose.yml` and updating `DATABASE_URL` to match.

---

## Repository layout

```
myno/
  docker-compose.yml
  NeMo_A100_Deployment.md
  backend/
    Dockerfile
    main.py               FastAPI app, DB models, chat orchestration
  asr/
    Dockerfile
    nemo_asr_server.py    Cache-aware streaming ASR WebSocket server
  tts/
    Dockerfile
    nemo_tts_server.py    FastPitch + HiFi-GAN synthesis server
  frontend/
    Dockerfile
    nginx.conf            Reverse proxy config for /api and /asr
    package.json
    vite.config.js
    index.html
    src/
      App.jsx             Full Myno UI
      main.jsx            Entry point; shims window.storage → localStorage
```

### Frontend notes

- **Responsive layout.** Viewports ≥ 1024 px show a website view with top navigation and wide two-column dashboards. Narrower viewports switch to a mobile view with a bottom tab bar. Layout updates on resize.
- **Persistence.** The app reads and writes via `window.storage`. `src/main.jsx` shims this with `localStorage`, so profile, logs, and settings persist in the browser between sessions.
- **Endpoint configuration.** In **Settings**, set Backend URL to `/api` and ASR endpoint to `wss://<host>/asr`. Both are proxied by nginx. Leave blank to use browser speech and direct Claude access.
