import React from "react";
import { BrandMark, Brand } from "../brand.jsx";

/**
 * Two doors.
 *
 * The same mark on both, in each side's own colour — the patient app's plum and
 * Dalīl's deeper ink — because they are one product in two registers. Each card
 * says who it is for in the first line, so nobody has to guess which one they
 * want.
 */
const APP = {
  plum: "#5c4b7d", plumDark: "#3e3159", lilac: "#c5b3d3", rose: "#ffe2e2",
  ink: "#2a2331", inkVar: "#4c4257", outline: "#736688",
};
const head = "'Manrope', 'Noto Kufi Arabic', system-ui, sans-serif";
const body = "'Hanken Grotesk', 'Noto Kufi Arabic', system-ui, sans-serif";

function Door({ href, ring, wordmark, latin, who, what, tint, border }) {
  const [hover, setHover] = React.useState(false);
  return (
    <a href={href}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: "block", textDecoration: "none", background: "#fff",
        border: `1.5px solid ${hover ? ring : border}`, borderRadius: 22, padding: "34px 30px 30px",
        boxShadow: hover ? "0 14px 40px rgba(42,35,49,0.13)" : "0 6px 22px rgba(42,35,49,0.06)",
        transform: hover ? "translateY(-3px)" : "none",
        transition: "transform .22s ease, box-shadow .22s ease, border-color .22s ease",
      }}>
      <span style={{ display: "inline-grid", placeItems: "center", width: 74, height: 74,
        borderRadius: 20, background: tint, marginBottom: 20 }}>
        <BrandMark size={50} ring={ring} fill="#fff" />
      </span>
      <div dir="rtl" style={{ fontFamily: head, fontWeight: 700, fontSize: 40, color: APP.ink,
        lineHeight: 1.1 }}>{wordmark}</div>
      <div style={{ fontFamily: body, fontSize: 13.5, color: APP.outline, margin: "6px 0 14px" }}>{latin}</div>
      <div style={{ fontFamily: head, fontWeight: 600, fontSize: 16.5, color: ring, marginBottom: 6 }}>{who}</div>
      <p style={{ fontFamily: body, fontSize: 14.5, lineHeight: 1.55, color: APP.inkVar, margin: 0 }}>{what}</p>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 20,
        fontFamily: body, fontWeight: 700, fontSize: 14.5, color: ring }}>
        Enter
        <span style={{ transition: "transform .2s ease", transform: hover ? "translateX(3px)" : "none" }}>→</span>
      </span>
    </a>
  );
}

export default function Landing() {
  return (
    <div style={{ minHeight: "100vh", background:
      "radial-gradient(circle at top right, #f3e8f6 0%, #fbefef 45%, #ffe2e2 100%)",
      display: "grid", placeItems: "center", padding: "40px 22px" }}>
      <main style={{ width: "100%", maxWidth: 860 }}>
        <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
          <Door href="/tawaazun/" ring={APP.plum} border="#efe3ef" tint={APP.rose}
            wordmark="توازن" latin="Tawaazun"
            who="If you have PMOS, or think you might"
            what="Track your cycle, symptoms and days by talking. See the patterns in your own data, and find out whether what you are seeing is worth taking to a doctor." />
          <Door href="/dalil/" ring="#3e3159" border="#e6e0ee" tint="#eeeaf3"
            wordmark="دليل" latin="Dalīl"
            who="If you research PMOS"
            what="The PMOS literature behind every claim the app makes: harvested from PubMed, appraised against a rubric, and signed off by a named reviewer before anyone sees it." />
        </div>

      </main>
    </div>
  );
}
