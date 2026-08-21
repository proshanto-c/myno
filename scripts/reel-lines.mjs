/**
 * Every line the guided demo speaks, one per output line, tab-separated:
 *
 *   guide<TAB>…    her own narration, in the cloned voice
 *   app<TAB>…      what Tawaazun answers with, in its own
 *
 * The point is the split: each line is one clip and one cache entry, keyed by
 * the exact text and the voice that says it. warm-voice.sh reads this and asks
 * for both, so nothing in the reel waits on synthesis.
 */
import { spokenLines, appLines } from "../frontend/src/demoreel.js";
for (const line of spokenLines()) process.stdout.write(`guide\t${line}\n`);
for (const line of appLines()) process.stdout.write(`app\t${line}\n`);
