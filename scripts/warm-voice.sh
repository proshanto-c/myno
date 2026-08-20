#!/usr/bin/env bash
# Say every line of the guided demo once, so the recording never waits for one.
#
#   ./scripts/warm-voice.sh
#
# Synthesis costs a couple of seconds a sentence, and the demo says the same
# sentences every single run — so they are paid for here, once, and served from
# the backend's cache from then on. Run it after clone-voice.sh, and again
# whenever the narration changes: lines that are already cached cost nothing.
set -euo pipefail

API=${API:-http://127.0.0.1:8080}          # the backend, where the cache lives
cd "$(dirname "$0")/.."

echo "→ collecting the lines"
LINES=$(docker run --rm -v "$PWD":/w -w /w node:20-alpine node scripts/reel-lines.mjs)
TOTAL=$(printf '%s\n' "$LINES" | grep -c . || true)
echo "   $TOTAL sentences"

i=0
printf '%s\n' "$LINES" | while IFS= read -r line; do
  [ -z "$line" ] && continue
  i=$((i + 1))
  body=$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$line")
  # One line that fails is one line the app synthesises live; it is not a
  # reason to abandon the other eighty. `set -e` would do exactly that.
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 300 \
         -X POST "$API/tts" -H 'Content-Type: application/json' -d "$body" || echo 000)
  printf '   [%3d/%s] %s %.60s\n' "$i" "$TOTAL" "$code" "$line"
  [ "$code" = "200" ] || echo "        ^ not cached — the app will fall back for this one"
done

echo "→ warm. The demo now speaks without waiting."
