/**
 * Dalīl's own tokens.
 *
 * Deliberately not the patient app's palette, and it never imports it. That one
 * is soft and rose because it sits with someone at 7am when they feel awful;
 * this one is read by a researcher comparing twelve papers, so it is ivory and
 * near-black with one accent, status colour reserved for verdicts alone, and
 * numerals that line up in a column.
 */
export const T = {
  bg: "#faf9f6",
  surface: "#ffffff",
  raised: "#f4f2ed",
  line: "#e6e3dc",
  lineStrong: "#cfcbc1",

  ink: "#15141a",
  inkMid: "#4b4954",
  inkSoft: "#7b7885",

  accent: "#2b3a8f",
  accentSoft: "#edeffa",

  good: "#1c6b45", goodSoft: "#e7f2ec",
  warn: "#8a5710", warnSoft: "#faf0dd",
  bad: "#96211f", badSoft: "#fbebea",
};

// A serif for headings and a sans for data is the whole visual argument: it
// reads as a document rather than an app, and costs nothing to load.
export const serif = "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif";
export const sans = "'Inter', 'Helvetica Neue', Arial, system-ui, sans-serif";
export const mono = "'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace";

/** Every number in a table lines up under the one above it. */
export const figures = { fontVariantNumeric: "tabular-nums", fontFeatureSettings: '"tnum"' };

export const verdictTone = (verdict) => ({
  meets: { fg: T.good, bg: T.goodSoft, label: "Meets" },
  considerations: { fg: T.warn, bg: T.warnSoft, label: "Considerations" },
  does_not_meet: { fg: T.bad, bg: T.badSoft, label: "Does not meet" },
}[verdict] || { fg: T.inkSoft, bg: T.raised, label: "Not appraised" });
