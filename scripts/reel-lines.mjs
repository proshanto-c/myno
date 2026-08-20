/**
 * Every line the guided demo says, one per output line.
 *
 * The point is the split: the browser asks for one sentence at a time, so the
 * cache in the backend is keyed per sentence. This prints exactly those
 * strings, from the same function the app speaks with — see warm-voice.sh.
 */
import { spokenLines } from "../frontend/src/demoreel.js";
for (const line of spokenLines()) process.stdout.write(line + "\n");
