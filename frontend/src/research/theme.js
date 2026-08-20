/**
 * Dalīl's tokens.
 *
 * The same family as Tawaazun, deeper. That is the point: this is not a
 * different product, it is the same one in its serious register — so the plum
 * the app uses at 5c4b7d becomes the near-black ink here, the lilac becomes a
 * line, and the rose survives only where bleeding is meant.
 *
 * What changes is weight, not hue: the patient app is soft because someone
 * reads it at 7am feeling awful; this is dense because a researcher is
 * comparing twelve papers. Same mark, same colours, different intent.
 */

// Tawaazun's own tokens, for reference — these are what the values below derive
// from, and the reason the two screens look related rather than merely adjacent.
export const APP = {
  plum: "#5c4b7d", plumDark: "#3e3159", lilac: "#c5b3d3",
  rose: "#ffe2e2", bleed: "#8c3f50", ink: "#2a2331",
};

export const T = {
  bg: "#f6f4f8",          // the app's ivory, pulled toward violet
  surface: "#ffffff",
  raised: "#eeeaf3",
  line: "#e2dcea",        // lilac, thinned to a rule
  lineStrong: "#c8bed6",

  ink: "#1e1830",         // deeper than the app's #2a2331
  inkMid: "#4b4360",
  inkSoft: "#7c7392",

  accent: "#3e3159",      // the app's plumDark, promoted to the accent
  accentSoft: "#e9e4f1",
  accentInk: "#ffffff",

  // Status colours, kept for verdicts alone. `bad` is the app's bleeding rose,
  // so red means the same thing on both sides of the product.
  good: "#1c6b45", goodSoft: "#e6f1eb",
  warn: "#8a5710", warnSoft: "#f8efdd",
  bad: "#8c3f50", badSoft: "#f8e9ec",
};

// A serif for headings against a sans for data: it reads as a document rather
// than an app, which is the one place Dalīl should not feel like Tawaazun.
export const serif = "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif";
export const sans = "'Hanken Grotesk', 'Inter', system-ui, sans-serif";
export const head = "'Manrope', 'Noto Kufi Arabic', system-ui, sans-serif";  // the app's heading face; carries both wordmarks
export const mono = "'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace";

/** Every number in a table lines up under the one above it. */
export const figures = { fontVariantNumeric: "tabular-nums", fontFeatureSettings: '"tnum"' };

export const verdictTone = (verdict) => ({
  meets: { fg: T.good, bg: T.goodSoft, label: "Meets" },
  considerations: { fg: T.warn, bg: T.warnSoft, label: "Considerations" },
  does_not_meet: { fg: T.bad, bg: T.badSoft, label: "Does not meet" },
}[verdict] || { fg: T.inkSoft, bg: T.raised, label: "Not appraised" });
