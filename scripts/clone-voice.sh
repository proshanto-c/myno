#!/usr/bin/env bash
# Clone one reference recording into the voice the whole app speaks in.
#
#   ./scripts/clone-voice.sh Haaniyah_Audio.opus Haaniyah
#
# It converts the recording to what a cloning engine wants (mono, 24 kHz, a
# clean 25-second stretch), registers it with VoiceStudio as a voice profile,
# and writes the profile id into .env as VOICE_ID. From then on every spoken
# line in Myno — the sign-up, the guided demo, and the replies on the Record
# screen — comes back in that voice, because they all go through the backend's
# /api/tts and that is where the id is read.
#
# Only run this on a recording you have the speaker's permission to clone.
# VoiceStudio keeps a consent field on every profile for exactly this reason.
set -euo pipefail

SRC=${1:?usage: clone-voice.sh <audio-file> [name]}
NAME=${2:-Haaniyah}
HOST=${VOICE_HOST:-http://127.0.0.1:3900}
OUT=voice/$(echo "$NAME" | tr '[:upper:] ' '[:lower:]_')_ref.wav
ENV_FILE=${ENV_FILE:-.env}

command -v ffmpeg >/dev/null || { echo "ffmpeg is needed to prepare the reference clip"; exit 1; }
[ -f "$SRC" ] || { echo "no such recording: $SRC"; exit 1; }

echo "→ waiting for VoiceStudio at $HOST"
for i in $(seq 1 60); do
  curl -sf "$HOST/health" >/dev/null && break
  [ "$i" = 60 ] && { echo "VoiceStudio never came up — is the 'voice' service running?"; exit 1; }
  sleep 5
done

# Leading silence trimmed, levels evened out, and capped at 25 seconds: past
# that the engines gain nothing and the upload only gets slower.
echo "→ preparing $OUT"
mkdir -p voice
ffmpeg -y -hide_banner -loglevel error -i "$SRC" \
  -af "silenceremove=start_periods=1:start_duration=0.1:start_threshold=-45dB,loudnorm=I=-18:TP=-2:LRA=11" \
  -ar 24000 -ac 1 -t 25 -c:a pcm_s16le "$OUT"

echo "→ registering the voice as '$NAME'"
ID=$(curl -sf -X POST "$HOST/profiles" \
      -F "name=$NAME" -F "kind=clone" -F "language=Auto" \
      -F "ref_audio=@$OUT;type=audio/wav" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
[ -n "$ID" ] || { echo "VoiceStudio did not return a profile id"; exit 1; }

# .env is what docker compose reads, so the id survives a restart.
touch "$ENV_FILE"
if grep -q '^VOICE_ID=' "$ENV_FILE"; then
  sed -i "s|^VOICE_ID=.*|VOICE_ID=$ID|" "$ENV_FILE"
else
  printf 'VOICE_ID=%s\n' "$ID" >> "$ENV_FILE"
fi

echo "→ VOICE_ID=$ID written to $ENV_FILE"
echo "   the first line spoken after this downloads the model, and takes a few minutes."
echo "   apply it with:  docker compose up -d backend"
