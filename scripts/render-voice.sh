#!/usr/bin/env bash
# Say every line of the guided demo once, and keep the recordings.
#
#   ./scripts/render-voice.sh
#
# The demo says the same twenty-odd sentences every single run, in a voice
# cloned from one recording of one person. Synthesising them on demand meant a
# GPU, a 15GB image and a model resident in VRAM, all to replay a fixed script
# — so they are rendered here, once, into frontend/public/voice/, and served as
# ordinary files from then on.
#
# Run it whenever the narration changes, with the voice service up. Files are
# named by a hash of who says what, so a line that has not changed keeps its
# name and its place in every browser cache that already has it.
set -euo pipefail

API=${API:-http://127.0.0.1:8080}
cd "$(dirname "$0")/.."
OUT=frontend/public/voice
mkdir -p "$OUT"

echo "→ collecting the lines"
LINES=$(docker run --rm -v "$PWD":/w -w /w node:20-alpine node scripts/reel-lines.mjs)
echo "   $(printf '%s\n' "$LINES" | grep -c .) sentences"

MANIFEST=frontend/src/clips.json
: > /tmp/clips.tsv
kept=0; failed=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  who=${line%%$'\t'*}
  text=${line#*$'\t'}
  name=$(printf '%s|%s' "$who" "$text" | sha1sum | cut -c1-10)
  mp3="$OUT/$name.mp3"
  if [ ! -f "$mp3" ]; then
    body=$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[2], "voice": sys.argv[1]}))' "$who" "$text")
    if ! curl -sf --max-time 300 -X POST "$API/tts" -H 'Content-Type: application/json' \
           -d "$body" -o /tmp/clip.wav; then
      echo "   ✗ $who: ${text:0:48}"; failed=$((failed + 1)); continue
    fi
    ffmpeg -loglevel error -y -i /tmp/clip.wav -ac 1 -codec:a libmp3lame -b:a 64k "$mp3"
  fi
  ms=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$mp3" \
       | python3 -c 'import sys; print(round(float(sys.stdin.read()) * 1000))')
  printf '%s\t%s\t%s\t%s\n' "$who" "$text" "$name" "$ms" >> /tmp/clips.tsv
  kept=$((kept + 1))
done <<< "$LINES"

python3 - "$MANIFEST" <<'PY'
import json, sys
clips = {}
for row in open("/tmp/clips.tsv"):
    who, text, name, ms = row.rstrip("\n").split("\t")
    clips[f"{who}|{text}"] = {"file": f"{name}.mp3", "ms": int(ms)}
json.dump(clips, open(sys.argv[1], "w"), indent=1, ensure_ascii=False)
print(f"   {len(clips)} in {sys.argv[1]}")
PY

echo "→ $kept rendered, $failed failed, $(du -sh $OUT | cut -f1) on disk"
