import React, { useCallback, useEffect, useState } from "react";
import { LogOut, RefreshCw, AlertTriangle, Library, ListChecks, FlaskConical, Download, Info } from "lucide-react";
import { BrandMark, Brand } from "../brand.jsx";
import { T, serif, sans, head, mono, figures, verdictTone } from "./theme";
import { api, SignedOut } from "./api";

/* ---- small atoms ---------------------------------------------------------- */
const Field = ({ label, children }) => (
  <label style={{ display: "block", marginBottom: 14 }}>
    <span style={{ display: "block", fontFamily: sans, fontSize: 12, fontWeight: 600,
      letterSpacing: "0.04em", textTransform: "uppercase", color: T.inkSoft, marginBottom: 6 }}>{label}</span>
    {children}
  </label>
);

const input = {
  width: "100%", padding: "11px 13px", borderRadius: 6, border: `1px solid ${T.lineStrong}`,
  fontFamily: sans, fontSize: 15, color: T.ink, background: T.surface, outline: "none",
};

function Button({ children, onClick, busy, kind = "primary", type = "button" }) {
  const primary = kind === "primary";
  return (
    <button type={type} onClick={onClick} disabled={busy}
      style={{ fontFamily: sans, fontWeight: 600, fontSize: 14, padding: "10px 16px", borderRadius: 6,
        cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
        background: primary ? T.accent : T.surface, color: primary ? "#fff" : T.ink,
        border: `1px solid ${primary ? T.accent : T.lineStrong}` }}>
      {children}
    </button>
  );
}

const Tag = ({ children, fg = T.inkMid, bg = T.raised }) => (
  <span style={{ fontFamily: sans, fontSize: 11, fontWeight: 600, letterSpacing: "0.02em",
    padding: "3px 8px", borderRadius: 4, background: bg, color: fg, whiteSpace: "nowrap" }}>{children}</span>
);

/* ---- the lockup ------------------------------------------------------------
   Same mark as the patient app, drawn in Dalīl's ink rather than the app's
   plum, with the relationship said out loud. Someone arriving here from
   Tawaazun should recognise where they are before reading a word. */
function Lockup({ size = 34 }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <BrandMark size={size} ring={T.accent} fill="#fff" />
      <div style={{ lineHeight: 1 }}>
        <div dir="rtl" style={{ fontFamily: head, fontWeight: 700, fontSize: size * 0.74,
          color: T.ink, display: "inline-block" }}>دليل</div>
        {/* Kept small and always present: the attribution is a subscript, not a
            second wordmark competing with the first. */}
        <div style={{ fontFamily: sans, fontSize: Math.max(9.5, size * 0.26), color: T.inkSoft,
          marginTop: size * 0.06, letterSpacing: "0.01em" }}>
          by <Brand font={head} style={{ fontSize: Math.max(10, size * 0.29), color: T.inkMid }} />
        </div>
      </div>
    </div>
  );
}

/* ---- signing in ----------------------------------------------------------- */
function SignIn({ onSignedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true); setError("");
    try {
      onSignedIn(await api.login(email, password));
    } catch (err) {
      setError(err.message || "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "grid", placeItems: "center", padding: 24 }}>
      <form onSubmit={submit} style={{ width: "100%", maxWidth: 380, background: T.surface,
        border: `1px solid ${T.line}`, borderRadius: 10, padding: 28 }}>
        <Lockup size={38} />
        <p style={{ fontFamily: sans, fontSize: 13.5, lineHeight: 1.5, color: T.inkMid, margin: "16px 0 22px" }}>
          Reviews are signed, so this needs your own account.
        </p>

        <Field label="Email">
          <input style={input} type="email" value={email} autoFocus autoComplete="username"
            onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <input style={input} type="password" value={password} autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)} />
        </Field>

        {error && (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", background: T.badSoft,
            border: `1px solid ${T.bad}22`, borderRadius: 6, padding: "9px 11px", marginBottom: 14 }}>
            <AlertTriangle size={14} color={T.bad} style={{ flexShrink: 0, marginTop: 2 }} />
            <span style={{ fontFamily: sans, fontSize: 13, color: T.bad }}>{error}</span>
          </div>
        )}

        <Button type="submit" busy={busy}>{busy ? "Checking…" : "Sign in"}</Button>
        <p style={{ fontFamily: sans, fontSize: 12, color: T.inkSoft, lineHeight: 1.5, margin: "18px 0 0" }}>
          Accounts are created by an administrator — there is no sign-up.
        </p>
      </form>
    </div>
  );
}

/* ---- the corpus ----------------------------------------------------------- */
const th = { fontFamily: sans, fontSize: 11, fontWeight: 700, letterSpacing: "0.05em",
  textTransform: "uppercase", color: T.inkSoft, textAlign: "left", padding: "0 14px 8px", whiteSpace: "nowrap" };
const td = { fontFamily: sans, fontSize: 13.5, color: T.ink, padding: "11px 14px",
  borderTop: `1px solid ${T.line}`, verticalAlign: "top" };
const card = { background: T.surface, border: `1px solid ${T.line}`, borderRadius: 8 };

const H2 = ({ children, count }) => (
  <header style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 14 }}>
    <h2 style={{ fontFamily: serif, fontSize: 24, fontWeight: 400, color: T.ink, margin: 0 }}>{children}</h2>
    {count !== undefined && (
      <span style={{ fontFamily: sans, fontSize: 13, color: T.inkSoft, ...figures }}>{count}</span>
    )}
  </header>
);

/** The corpus in six numbers. Density is the point: a researcher wants the
    shape of the library before any one row of it. */
function Summary({ s }) {
  if (!s) return null;
  const states = s.byState || {};
  const cells = [
    ["Sources", s.total, ""],
    ["Open access", s.openAccess, `${s.fulltext || 0} with full text`],
    ["Not yet checked", s.unchecked, s.unchecked ? "run Enrich" : "all checked"],
    ["Needs text", states.needs_text || 0, "no abstract, no open text"],
    ["Excluded", states.excluded || 0, `${s.retracted || 0} retracted`],
    ["References held", s.citations, `${s.unpromoted || 0} not yet followed`],
  ];
  return (
    <div style={{ display: "grid", gap: 10, marginBottom: 18,
      gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
      {cells.map(([label, value, note]) => (
        <div key={label} style={{ ...card, padding: "12px 14px" }}>
          <div style={{ fontFamily: sans, fontSize: 11, fontWeight: 700, letterSpacing: "0.05em",
            textTransform: "uppercase", color: T.inkSoft }}>{label}</div>
          <div style={{ fontFamily: sans, fontSize: 26, fontWeight: 700, color: T.ink,
            lineHeight: 1.2, ...figures }}>{value ?? 0}</div>
          {note && <div style={{ fontFamily: sans, fontSize: 11.5, color: T.inkSoft }}>{note}</div>}
        </div>
      ))}
    </div>
  );
}

const STATES = ["", "new", "needs_text", "included", "excluded", "appraised"];
const stateLabel = (s) => (s === "" ? "All" : s.replace("_", " "));

/* ---- how long ago -----------------------------------------------------------
   A corpus is only as good as the last time PubMed was asked, so the age of
   that answer belongs on the page rather than in a log. Green inside a day,
   amber inside a week, red past that or never — the same three bands wherever
   freshness is shown, so the colour means one thing across the portal. */
const FRESH_HOURS = 24;
const STALE_HOURS = 24 * 7;

function ago(when) {
  if (!when) return { text: "never", hours: Infinity };
  const then = instant(when);
  if (!Number.isFinite(then)) return { text: when, hours: Infinity };
  const hours = Math.max(0, (Date.now() - then) / 3600000);
  if (hours < 1) return { text: "just now", hours };
  if (hours < 24) return { text: `${Math.round(hours)}h ago`, hours };
  const days = Math.round(hours / 24);
  return { text: `${days}d ago`, hours };
}

const freshTone = (hours) =>
  hours < FRESH_HOURS ? { fg: T.good, bg: T.goodSoft }
    : hours < STALE_HOURS ? { fg: T.warn, bg: T.warnSoft }
      : { fg: T.bad, bg: T.badSoft };

/**
 * A server timestamp, read as the UTC it actually is.
 *
 * `datetime.utcnow().isoformat()` carries no zone, and JavaScript reads a
 * zoneless date-time as *local*. On a browser an hour east of UTC that makes a
 * job which started ten seconds ago look like one starting in an hour, and a
 * corpus synced this morning look like it was synced tonight. A bare date is
 * the opposite case — `Date.parse` treats "2026/08/21" as UTC midnight — so it
 * is spelled out as local instead.
 */
function instant(t) {
  if (!t) return NaN;
  if (/^\d{4}[/-]\d{2}[/-]\d{2}$/.test(t)) return Date.parse(`${t.replace(/\//g, "-")}T00:00:00`);
  return Date.parse(/[Zz]|[+-]\d{2}:\d{2}$/.test(t) ? t : `${t}Z`);
}

/** How long a job has been going, or how long it took. */
function elapsed(from, to) {
  const utc = instant;
  const start = utc(from);
  if (!Number.isFinite(start)) return "";
  const end = to ? Date.parse(utc(to)) : Date.now();
  const s = Math.max(0, Math.round((end - start) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** "3h ago", coloured by how long ago that was. */
function Ago({ when, prefix = "" }) {
  const { text, hours } = ago(when);
  const tone = freshTone(hours);
  return <Tag fg={tone.fg} bg={tone.bg}>{prefix}{text}</Tag>;
}

function Corpus({ data, loading, onRefresh, filter, setFilter, onOpen }) {
  const sources = data.sources || [];
  return (
    <section>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 14 }}>
        <h2 style={{ fontFamily: serif, fontSize: 24, fontWeight: 400, color: T.ink, margin: 0 }}>Corpus</h2>
        <span style={{ fontFamily: sans, fontSize: 13, color: T.inkSoft, ...figures }}>
          {sources.length} shown
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontFamily: sans, fontSize: 12.5, color: T.inkSoft }}>synced</span>
          <Ago when={data.summary?.lastSync} />
        </span>
      </header>
      <Summary s={data.summary} />

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 14 }}>
        {STATES.map((st) => {
          const on = filter.state === st;
          return (
            <button key={st || "all"} onClick={() => setFilter({ ...filter, state: st })}
              style={{ fontFamily: sans, fontSize: 12.5, fontWeight: on ? 700 : 500, cursor: "pointer",
                padding: "6px 11px", borderRadius: 6, background: on ? T.accentSoft : T.surface,
                color: on ? T.accent : T.inkMid, border: `1px solid ${on ? T.accent : T.line}` }}>
              {stateLabel(st)}
            </button>
          );
        })}
        <input value={filter.q} placeholder="Search titles"
          onChange={(e) => setFilter({ ...filter, q: e.target.value })}
          style={{ ...input, width: 220, padding: "7px 11px", fontSize: 13 }} />
        <span style={{ marginLeft: "auto" }}>
          <Button kind="ghost" onClick={onRefresh} busy={loading}>
            <RefreshCw size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />Refresh
          </Button>
        </span>
      </div>

      {sources.length === 0 ? (
        <div style={{ ...card, border: `1px dashed ${T.lineStrong}`, padding: 28, textAlign: "center" }}>
          <Library size={20} color={T.inkSoft} />
          <p style={{ fontFamily: sans, fontSize: 14, color: T.inkMid, lineHeight: 1.55, margin: "10px auto 0", maxWidth: 460 }}>
            Nothing here yet. The first seed is the StatPearls chapter this condition is named
            after — <span style={{ fontFamily: mono, fontSize: 12.5 }}>NBK459251</span> — and the 55
            papers it cites. Run it from Harvest.
          </p>
        </div>
      ) : (
        <div style={{ ...card, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ background: T.raised }}>
              <th style={{ ...th, paddingTop: 10 }}>Title</th>
              <th style={{ ...th, paddingTop: 10 }}>Source</th>
              <th style={{ ...th, paddingTop: 10 }}>Year</th>
              <th style={{ ...th, paddingTop: 10 }}>Text</th>
              <th style={{ ...th, paddingTop: 10 }}>State</th>
            </tr></thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id} onClick={() => onOpen(s.id)} style={{ cursor: "pointer" }}>
                  <td style={{ ...td, maxWidth: 460 }}>
                    <div style={{ lineHeight: 1.45 }}>{s.title || "—"}</div>
                    <div style={{ fontFamily: mono, fontSize: 11.5, color: T.inkSoft, marginTop: 3 }}>
                      {s.pmid ? `PMID ${s.pmid}` : ""}{s.nbk ? `  ${s.nbk}` : ""}
                    </div>
                  </td>
                  <td style={{ ...td, color: T.inkMid }}>{s.journal || "—"}</td>
                  <td style={{ ...td, ...figures }}>{s.year || "—"}</td>
                  <td style={td}>
                    {s.hasFulltext ? <Tag fg={T.good} bg={T.goodSoft}>{s.licence || "full text"}</Tag>
                      : s.licence ? <Tag>{s.licence}</Tag> : <Tag>abstract only</Tag>}
                  </td>
                  <td style={td}>
                    {s.retracted ? <Tag fg={T.bad} bg={T.badSoft}>retracted</Tag>
                      : <Tag>{stateLabel(s.screenState)}</Tag>}
                    {(s.flags || []).map((f) => (
                      <Tag key={f} fg={T.bad} bg={T.badSoft}>{f.replace("_", " ")}</Tag>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** One source, opened from the table. Everything held about it, including what
    it cites — which is where the next round of harvesting comes from. */
function SourcePanel({ source, onClose, onReport }) {
  if (!source) return null;
  const link = source.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${source.pmid}/`
    : source.nbk ? `https://www.ncbi.nlm.nih.gov/books/${source.nbk}/` : null;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "#1e183055",
      display: "flex", justifyContent: "flex-end", zIndex: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(620px, 100%)", background: T.bg,
        height: "100%", overflowY: "auto", borderLeft: `1px solid ${T.lineStrong}`, padding: "22px 24px 60px" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <h3 style={{ fontFamily: serif, fontSize: 20, fontWeight: 400, color: T.ink,
            margin: 0, lineHeight: 1.35, flex: 1 }}>{source.title}</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer",
            color: T.inkSoft, fontFamily: sans, fontSize: 13 }}>Close</button>
        </div>
        <div style={{ fontFamily: sans, fontSize: 13, color: T.inkMid, margin: "8px 0 14px" }}>
          {(source.authors || []).join(", ")}{source.authors?.length ? " · " : ""}
          {source.journal || "—"} {source.year || ""}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
          {source.pmid && <Tag>PMID {source.pmid}</Tag>}
          {source.pmcid && <Tag>{source.pmcid}</Tag>}
          {source.nbk && <Tag>{source.nbk}</Tag>}
          {source.licence && <Tag>{source.licence}</Tag>}
          <Tag>{stateLabel(source.screenState)}</Tag>
          {(source.pubTypes || []).map((p) => <Tag key={p}>{p}</Tag>)}
          {source.retracted && <Tag fg={T.bad} bg={T.badSoft}>retracted</Tag>}
        </div>
        {source.screenReason && (
          <p style={{ fontFamily: sans, fontSize: 13, color: T.inkMid, margin: "0 0 14px" }}>
            {source.screenReason}
          </p>
        )}
        <div style={{ display: "flex", gap: 12, alignItems: "center", margin: "0 0 18px" }}>
          <Button onClick={() => onReport(source.id)}>
            {source.screenState === "appraised" ? "Read the report" : "Appraise"}
          </Button>
          {link && (
            <a href={link} target="_blank" rel="noreferrer"
              style={{ fontFamily: sans, fontSize: 13.5, color: T.accent }}>Open at NCBI →</a>
          )}
        </div>

        <Section title="Abstract">
          <p style={{ fontFamily: sans, fontSize: 13.5, lineHeight: 1.6, color: T.ink, margin: 0,
            whiteSpace: "pre-wrap" }}>{source.abstract || "PubMed holds no abstract for this record."}</p>
        </Section>

        {source.fulltextChars > 0 && (
          <Section title="Full text">
            <p style={{ fontFamily: sans, fontSize: 13, color: T.inkMid, margin: 0, ...figures }}>
              {source.fulltextChars.toLocaleString()} characters across {source.passages?.length || 0} passages
              {" — "}{[...new Set((source.passages || []).map((p) => p.section))].join(", ").toLowerCase()}.
            </p>
          </Section>
        )}

        {(source.mesh || []).length > 0 && (
          <Section title="MeSH">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {source.mesh.map((m) => <Tag key={m}>{m}</Tag>)}
            </div>
          </Section>
        )}

        {(source.citations || []).length > 0 && (
          <Section title={`References (${source.citations.length})`}>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              {source.citations.map((c, i) => (
                <li key={i} style={{ fontFamily: sans, fontSize: 12.5, lineHeight: 1.5,
                  color: c.promoted ? T.inkSoft : T.ink, marginBottom: 5 }}>
                  {c.raw || c.pmid}
                  {c.promoted && <span style={{ color: T.good }}> · in corpus</span>}
                </li>
              ))}
            </ol>
          </Section>
        )}
      </div>
    </div>
  );
}

const Section = ({ title, children }) => (
  <div style={{ ...card, padding: "14px 16px", marginBottom: 12 }}>
    <div style={{ fontFamily: sans, fontSize: 11, fontWeight: 700, letterSpacing: "0.05em",
      textTransform: "uppercase", color: T.inkSoft, marginBottom: 8 }}>{title}</div>
    {children}
  </div>
);

// Which way the finding runs. Declared above its first use rather than beside
// its second: a const referenced before its initialiser has blanked this app's
// screen three times already.
const arrow = { "+": "↑", "-": "↓", "0": "→" };

/* ---- the queue --------------------------------------------------------------
   One claim at a time, strongest paper first, with the keys under a reviewer's
   fingers. A hundred claims in an hour is only possible if the decision is the
   slow part, so everything else — finding the quote, checking the bindings,
   knowing what the rubric thought — is already on the card. */
const KEYS = { a: "accept", r: "reject", p: "publish" };

function Queue({ data, onAct, onSkip, index, busy, problems, candidates }) {
  const rows = data.claims || [];
  const claim = rows[index];
  const [display, setDisplay] = React.useState("");
  const [reason, setReason] = React.useState("");

  React.useEffect(() => { setDisplay(claim?.displayText || ""); setReason(""); }, [claim?.id]);

  const act = React.useCallback((action) => {
    if (!claim || busy) return;
    onAct(claim, action, { display, reason });
  }, [claim, busy, display, reason, onAct]);

  React.useEffect(() => {
    const onKey = (e) => {
      // never while somebody is typing the sentence a patient will read
      if (["INPUT", "TEXTAREA"].includes(e.target?.tagName)) return;
      if (e.key === "ArrowRight") { onSkip(1); return; }
      if (e.key === "ArrowLeft") { onSkip(-1); return; }
      const action = KEYS[e.key?.toLowerCase()];
      if (action) { e.preventDefault(); act(action); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, onSkip]);

  const words = display.trim() ? display.trim().split(/\s+/).length : 0;

  return (
    <section>
      <H2 count={`${data.open || 0} open · ${data.published || 0} published`}>Queue</H2>

      {data.signedIn === false && data.reviewer && (
        <div style={{ ...card, padding: "10px 14px", marginBottom: 14, background: T.accentSoft,
          border: `1px solid ${T.accent}22`, fontFamily: sans, fontSize: 13, color: T.inkMid }}>
          Sign-in is off, so every review is signed as <b>{data.reviewer}</b>. Turn
          <span style={{ fontFamily: mono, fontSize: 12 }}> DALIL_REQUIRE_AUTH=1 </span>
          on to have people sign in as themselves.
        </div>
      )}

      {!claim ? (
        <div style={{ ...card, border: `1px dashed ${T.lineStrong}`, padding: 26, textAlign: "center" }}>
          <ListChecks size={20} color={T.inkSoft} />
          <p style={{ fontFamily: sans, fontSize: 14, color: T.inkMid, lineHeight: 1.55,
            margin: "10px auto 0", maxWidth: 460 }}>
            Nothing waiting. Appraise some sources and any claim that survives quote verification
            arrives here.
          </p>
        </div>
      ) : (
        <div style={{ ...card, padding: "20px 22px" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap",
            marginBottom: 4 }}>
            <span style={{ fontFamily: sans, fontSize: 12.5, color: T.inkSoft, ...figures }}>
              {index + 1} of {rows.length}
            </span>
            {claim.report && (
              <Tag fg={verdictTone(claim.report.verdict).fg} bg={verdictTone(claim.report.verdict).bg}>
                {claim.report.score}/100 · {verdictTone(claim.report.verdict).label}
              </Tag>
            )}
            {(claim.report?.flags || []).map((f) => (
              <Tag key={f} fg={T.bad} bg={T.badSoft}>{f.split(":")[0].replace(/_/g, " ")}</Tag>
            ))}
            <Tag>{claim.state}</Tag>
          </div>
          <div style={{ fontFamily: sans, fontSize: 13, color: T.inkMid, marginBottom: 16 }}>
            {claim.source?.title} · {claim.source?.journal} {claim.source?.year}
            {claim.source?.pmid && <> · <a target="_blank" rel="noreferrer"
              href={`https://pubmed.ncbi.nlm.nih.gov/${claim.source.pmid}/`}
              style={{ color: T.accent }}>PMID {claim.source.pmid}</a></>}
          </div>

          <p style={{ fontFamily: serif, fontSize: 19, lineHeight: 1.45, color: T.ink,
            margin: "0 0 12px" }}>{claim.claimText}</p>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
            {(claim.fields || []).map((f) => (
              <Tag key={f.role + f.key} fg={f.proposed ? T.warn : T.accent}
                bg={f.proposed ? T.warnSoft : T.accentSoft}>
                {f.role}: {f.key}{f.proposed ? " (proposed)" : ""}
              </Tag>
            ))}
            <Tag>{arrow[claim.direction] || claim.direction} {claim.relation?.replace("_", " ")}</Tag>
            <Tag>certainty {claim.certainty}</Tag>
            {claim.population && <Tag>{claim.population}</Tag>}
          </div>

          <blockquote style={{ margin: "0 0 18px", padding: "10px 14px", background: T.raised,
            borderLeft: `3px solid ${T.lineStrong}`, borderRadius: 4, fontFamily: serif,
            fontSize: 14.5, lineHeight: 1.6, color: T.ink }}>
            “{claim.quote}”
            <span style={{ fontFamily: mono, fontSize: 11, color: T.inkSoft, display: "block",
              marginTop: 6 }}>
              {(claim.quoteSection || "text").toLowerCase()} · character {claim.quoteOffset}
              {claim.quoteVerified ? " · found in the stored text" : " · UNVERIFIED"}
            </span>
          </blockquote>

          <Field label={`What the patient reads — your words, not the paper's (${words}/25)`}>
            <input style={{ ...input, borderColor: words > 25 ? T.bad : T.lineStrong }}
              value={display} placeholder="Shorter sleep tracks with more brain fog"
              onChange={(e) => setDisplay(e.target.value)} />
          </Field>

          {claim.report && claim.report.score < 45 && (
            <Field label="Why publish something the rubric scored below 45?">
              <input style={input} value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="The only trial in this population" />
            </Field>
          )}

          {problems.length > 0 && (
            <div style={{ background: T.badSoft, border: `1px solid ${T.bad}22`, borderRadius: 6,
              padding: "10px 12px", marginBottom: 14 }}>
              {problems.map((p) => (
                <div key={p} style={{ fontFamily: sans, fontSize: 13, color: T.bad,
                  lineHeight: 1.5 }}>· {p}</div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Button busy={busy} onClick={() => act("publish")}>Publish</Button>
            <Button kind="ghost" busy={busy} onClick={() => act("accept")}>Accept</Button>
            <Button kind="ghost" busy={busy} onClick={() => act("reject")}>Reject</Button>
            <Button kind="ghost" busy={busy} onClick={() => onSkip(1)}>Skip</Button>
            <span style={{ fontFamily: mono, fontSize: 11.5, color: T.inkSoft, marginLeft: "auto" }}>
              p publish · a accept · r reject · ← → move
            </span>
          </div>
        </div>
      )}

      {(candidates?.correlations?.length > 0 || candidates?.fields?.length > 0) && (
        <div style={{ marginTop: 26 }}>
          <H2>What the literature keeps asking for</H2>
          <div style={{ display: "grid", gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
            <Section title="Pairs Insights does not correlate yet">
              {candidates.correlations.length === 0
                ? <span style={{ fontFamily: sans, fontSize: 13, color: T.inkSoft }}>None.</span>
                : candidates.correlations.map((c) => (
                    <div key={c.exposure + c.outcome} style={{ fontFamily: sans, fontSize: 13.5,
                      color: T.ink, lineHeight: 1.8 }}>
                      {c.exposure} → {c.outcome}
                      <span style={{ color: T.inkSoft }}> · {c.claims} claim{c.claims === 1 ? "" : "s"}</span>
                    </div>
                  ))}
            </Section>
            <Section title="Fields the app does not record">
              {candidates.fields.length === 0
                ? <span style={{ fontFamily: sans, fontSize: 13, color: T.inkSoft }}>None.</span>
                : candidates.fields.map((f) => (
                    <div key={f.key} style={{ fontFamily: sans, fontSize: 13.5, color: T.ink,
                      lineHeight: 1.8 }}>
                      {f.labels[0] || f.key}
                      <span style={{ color: T.inkSoft }}> · {f.claims} claim{f.claims === 1 ? "" : "s"}</span>
                    </div>
                  ))}
              <p style={{ fontFamily: sans, fontSize: 12, color: T.inkSoft, lineHeight: 1.5,
                margin: "10px 0 0" }}>
                Adopting one means adding it to the app's daily record, which is a decision a
                person makes — never something this module does on its own.
              </p>
            </Section>
          </div>
        </div>
      )}
    </section>
  );
}

/* ---- the report ------------------------------------------------------------
   A document, not a dashboard: verdict first, then what was found, then the
   evidence behind each line, then the flags, then where it all came from. The
   quote under every model-scored module is the point — a score with no sentence
   behind it is the thing this module exists to replace. */
function Verdict({ report }) {
  const tone = verdictTone(report.verdict);
  const found = report.verified || {};
  return (
    <div style={{ ...card, padding: "18px 20px", marginBottom: 14,
      borderLeft: `4px solid ${tone.fg}`, display: "flex", gap: 26, alignItems: "center",
      flexWrap: "wrap" }}>
      <div>
        <div style={{ fontFamily: sans, fontSize: 11, fontWeight: 700, letterSpacing: "0.06em",
          textTransform: "uppercase", color: T.inkSoft }}>Verdict</div>
        <div style={{ fontFamily: serif, fontSize: 26, color: tone.fg }}>{tone.label}</div>
      </div>
      <div>
        <div style={{ fontFamily: sans, fontSize: 11, fontWeight: 700, letterSpacing: "0.06em",
          textTransform: "uppercase", color: T.inkSoft }}>Score</div>
        <div style={{ fontFamily: sans, fontSize: 26, fontWeight: 700, color: T.ink, ...figures }}>
          {report.score}<span style={{ fontSize: 15, color: T.inkSoft }}>/100</span>
        </div>
      </div>
      <div>
        <div style={{ fontFamily: sans, fontSize: 11, fontWeight: 700, letterSpacing: "0.06em",
          textTransform: "uppercase", color: T.inkSoft }}>Findings verified</div>
        <div style={{ fontFamily: sans, fontSize: 26, fontWeight: 700, ...figures,
          color: found.found === found.of ? T.good : T.warn }}>
          {found.found ?? 0}<span style={{ fontSize: 15, color: T.inkSoft }}>/{found.of ?? 0}</span>
        </div>
      </div>
    </div>
  );
}

const basisTone = (basis) => ({
  deterministic: { fg: T.inkMid, bg: T.raised, label: "from the record" },
  gate: { fg: T.bad, bg: T.badSoft, label: "gate" },
  model: { fg: T.accent, bg: T.accentSoft, label: "read from the text" },
}[basis] || { fg: T.inkSoft, bg: T.raised, label: basis });

function ModuleRows({ modules }) {
  return (
    <div style={{ ...card, overflow: "hidden", marginBottom: 14 }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr style={{ background: T.raised }}>
          <th style={{ ...th, paddingTop: 10 }}>Module</th>
          <th style={{ ...th, paddingTop: 10, textAlign: "right" }}>Score</th>
          <th style={{ ...th, paddingTop: 10 }}>Basis</th>
          <th style={{ ...th, paddingTop: 10 }}>What it says</th>
        </tr></thead>
        <tbody>
          {modules.map((m) => {
            const tone = basisTone(m.basis);
            const share = m.weight ? m.score / m.weight : 0;
            return (
              <tr key={m.key}>
                <td style={{ ...td, fontWeight: 600, whiteSpace: "nowrap" }}>{m.label}</td>
                <td style={{ ...td, textAlign: "right", ...figures, whiteSpace: "nowrap" }}>
                  <span style={{ fontWeight: 700,
                    color: share >= 0.75 ? T.good : share >= 0.4 ? T.ink : T.bad }}>{m.score}</span>
                  <span style={{ color: T.inkSoft }}>/{m.weight}</span>
                </td>
                <td style={td}><Tag fg={tone.fg} bg={tone.bg}>{tone.label}</Tag></td>
                <td style={{ ...td, maxWidth: 520 }}>
                  <div style={{ lineHeight: 1.5 }}>{m.note || "—"}</div>
                  {m.quote && (
                    <blockquote style={{ margin: "8px 0 0", paddingLeft: 11,
                      borderLeft: `2px solid ${m.offset >= 0 ? T.lineStrong : T.bad}`,
                      fontFamily: serif, fontSize: 13, lineHeight: 1.55,
                      color: m.offset >= 0 ? T.inkMid : T.bad }}>
                      {m.offset >= 0 ? "" : "not found in the text — scored zero: "}
                      “{m.quote}”
                      {m.offset >= 0 && (
                        <span style={{ fontFamily: mono, fontSize: 11, color: T.inkSoft,
                          display: "block", marginTop: 4 }}>
                          {(m.section || "text").toLowerCase()} · character {m.offset.toLocaleString()}
                        </span>
                      )}
                    </blockquote>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ClaimCard({ claim }) {
  const bound = claim.fields || [];
  return (
    <div style={{ ...card, padding: "14px 16px", marginBottom: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontFamily: sans, fontSize: 15, fontWeight: 600, color: T.ink, flex: 1,
          lineHeight: 1.45 }}>{claim.claimText}</span>
        <Tag>{claim.state}</Tag>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "10px 0" }}>
        {bound.map((f) => (
          <Tag key={f.key + f.role} fg={f.proposed ? T.warn : T.accent}
            bg={f.proposed ? T.warnSoft : T.accentSoft}>
            {f.role}: {f.key}{f.proposed ? " (proposed)" : ""}
          </Tag>
        ))}
        <Tag>{arrow[claim.direction] || claim.direction} {claim.relation?.replace("_", " ")}</Tag>
        <Tag>certainty {claim.certainty}</Tag>
        {claim.effect?.measure && (
          <Tag>{claim.effect.measure}{claim.effect.value != null ? ` ${claim.effect.value}` : ""}
            {claim.effect.p != null ? `, p ${claim.effect.p}` : ""}</Tag>
        )}
      </div>
      {claim.population && (
        <div style={{ fontFamily: sans, fontSize: 12.5, color: T.inkSoft, marginBottom: 8 }}>
          in {claim.population}
        </div>
      )}
      <blockquote style={{ margin: 0, paddingLeft: 11, borderLeft: `2px solid ${T.lineStrong}`,
        fontFamily: serif, fontSize: 13.5, lineHeight: 1.6, color: T.inkMid }}>
        “{claim.quote}”
        <span style={{ fontFamily: mono, fontSize: 11, color: T.inkSoft, display: "block", marginTop: 4 }}>
          {(claim.quoteSection || "text").toLowerCase()} · character {claim.quoteOffset?.toLocaleString()}
          {claim.quoteVerified ? " · found in the stored text" : " · UNVERIFIED"}
        </span>
      </blockquote>
    </div>
  );
}

function ReportView({ data, onBack, onAppraise, busy }) {
  const { source, report, claims = [], citedBy } = data;
  const link = source.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${source.pmid}/`
    : source.nbk ? `https://www.ncbi.nlm.nih.gov/books/${source.nbk}/` : null;
  return (
    <section>
      <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer",
        color: T.accent, fontFamily: sans, fontSize: 13.5, padding: 0, marginBottom: 12 }}>
        ← All reports
      </button>
      <h2 style={{ fontFamily: serif, fontSize: 25, fontWeight: 400, color: T.ink,
        margin: "0 0 6px", lineHeight: 1.3 }}>{source.title}</h2>
      <div style={{ fontFamily: sans, fontSize: 13.5, color: T.inkMid, marginBottom: 16 }}>
        {source.journal || "—"} {source.year || ""} · cited by {citedBy} in this corpus
        {link && <> · <a href={link} target="_blank" rel="noreferrer"
          style={{ color: T.accent }}>NCBI</a></>}
      </div>

      {!report ? (
        <div style={{ ...card, border: `1px dashed ${T.lineStrong}`, padding: 26, textAlign: "center" }}>
          <p style={{ fontFamily: sans, fontSize: 14, color: T.inkMid, margin: "0 0 14px" }}>
            Not appraised yet.
          </p>
          <Button busy={busy} onClick={() => onAppraise(source.id)}>Appraise this one</Button>
        </div>
      ) : (
        <>
          <Verdict report={report} />
          {report.narrative && (
            <p style={{ ...card, padding: "14px 18px", fontFamily: serif, fontSize: 15.5,
              lineHeight: 1.6, color: T.ink, margin: "0 0 14px" }}>{report.narrative}</p>
          )}
          {(report.flags || []).length > 0 && (
            <div style={{ ...card, padding: "12px 16px", marginBottom: 14,
              background: T.badSoft, border: `1px solid ${T.bad}33` }}>
              <div style={{ fontFamily: sans, fontSize: 11, fontWeight: 700, letterSpacing: "0.05em",
                textTransform: "uppercase", color: T.bad, marginBottom: 7 }}>Flags</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {report.flags.map((f) => (
                  <Tag key={f} fg={T.bad} bg="#fff">{f.replace(/_/g, " ").replace(":", ": ")}</Tag>
                ))}
              </div>
            </div>
          )}

          <ModuleRows modules={report.modules || []} />

          <H2 count={`${claims.length}`}>Claims</H2>
          {claims.length === 0
            ? <p style={{ ...card, padding: "14px 16px", fontFamily: sans, fontSize: 13.5,
                color: T.inkMid, margin: "0 0 14px" }}>
                No claim survived verification. Every finding the model offered either quoted a
                sentence that is not in the stored text, or bound to something the app does not record.
              </p>
            : claims.map((c) => <ClaimCard key={c.id} claim={c} />)}

          {/* Provenance matters and is almost never read, so it sits as one
              line that opens rather than a block that has to be scrolled past
              on the way to the next report. */}
          <details style={{ ...card, padding: "10px 16px", marginTop: 4 }}>
            <summary style={{ cursor: "pointer", fontFamily: sans, fontSize: 12,
              fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
              color: T.inkSoft, listStyle: "revert" }}>
              Provenance — rubric {report.rubricVersion}, {report.model || "no model"}
            </summary>
            <div style={{ fontFamily: mono, fontSize: 12, color: T.inkMid, lineHeight: 1.7,
              marginTop: 8 }}>
              rubric {report.rubricVersion} · prompt {report.promptVersion} · {report.model || "no model"}<br />
              {(report.tokensIn || 0).toLocaleString()} tokens in, {(report.tokensOut || 0).toLocaleString()} out
              · {(report.createdAt || "").replace("T", " ").slice(0, 16)}
            </div>
          </details>
        </>
      )}
    </section>
  );
}

const VERDICTS = ["", "meets", "considerations", "does_not_meet"];
const SORTS = [["recent", "Newest"], ["score", "Highest score"], ["weakest", "Weakest first"]];

function ReportList({ rows, total, verdicts, onOpen, filter, setFilter, loading }) {
  const set = (patch) => setFilter({ ...filter, ...patch });
  return (
    <section>
      <H2 count={total > rows.length ? `${rows.length} of ${total}` : `${total ?? rows.length}`}>
        Reports
      </H2>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 14 }}>
        {VERDICTS.map((v) => {
          const on = filter.verdict === v;
          const tone = v ? verdictTone(v) : { label: "All" };
          const count = v ? (verdicts || {})[v] : undefined;
          return (
            <button key={v || "all"} onClick={() => set({ verdict: v })}
              style={{ fontFamily: sans, fontSize: 12.5, fontWeight: on ? 700 : 500, cursor: "pointer",
                padding: "6px 11px", borderRadius: 6, background: on ? T.accentSoft : T.surface,
                color: on ? T.accent : T.inkMid, border: `1px solid ${on ? T.accent : T.line}` }}>
              {tone.label}{count !== undefined ? ` ${count}` : ""}
            </button>
          );
        })}
        <button onClick={() => set({ flagged: !filter.flagged })}
          style={{ fontFamily: sans, fontSize: 12.5, fontWeight: filter.flagged ? 700 : 500,
            cursor: "pointer", padding: "6px 11px", borderRadius: 6,
            background: filter.flagged ? T.badSoft : T.surface,
            color: filter.flagged ? T.bad : T.inkMid,
            border: `1px solid ${filter.flagged ? T.bad : T.line}` }}>
          Flagged only
        </button>

        {/* Title, journal, PMID or a half-remembered phrase from the narrative —
            all four are what a researcher actually types. */}
        <input value={filter.q} placeholder="Search title, journal, PMID…"
          onChange={(e) => set({ q: e.target.value })}
          style={{ ...input, width: 250, padding: "7px 11px", fontSize: 13 }} />

        <select value={filter.sort} onChange={(e) => set({ sort: e.target.value })}
          style={{ ...input, width: "auto", padding: "7px 11px", fontSize: 13, cursor: "pointer" }}>
          {SORTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>

        {(filter.q || filter.verdict || filter.flagged) && (
          <button onClick={() => set({ q: "", verdict: "", flagged: false })}
            style={{ background: "none", border: "none", cursor: "pointer", color: T.accent,
              fontFamily: sans, fontSize: 13 }}>Clear</button>
        )}
      </div>

      {rows.length === 0 && (filter.q || filter.verdict || filter.flagged) ? (
        <div style={{ ...card, border: `1px dashed ${T.lineStrong}`, padding: 26, textAlign: "center" }}>
          <p style={{ fontFamily: sans, fontSize: 14, color: T.inkMid, margin: 0 }}>
            No report matches that. {total === 0 ? "" : `${total} in total.`}
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div style={{ ...card, border: `1px dashed ${T.lineStrong}`, padding: 26, textAlign: "center" }}>
          <FlaskConical size={20} color={T.inkSoft} />
          <p style={{ fontFamily: sans, fontSize: 14, color: T.inkMid, lineHeight: 1.55,
            margin: "10px auto 0", maxWidth: 460 }}>
            Nothing appraised yet. Each report scores ten modules and carries the sentence behind
            every one of them.
          </p>
        </div>
      ) : (
        <div style={{ ...card, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ background: T.raised }}>
              <th style={{ ...th, paddingTop: 10 }}>Paper</th>
              <th style={{ ...th, paddingTop: 10, textAlign: "right" }}>Score</th>
              <th style={{ ...th, paddingTop: 10 }}>Verdict</th>
              <th style={{ ...th, paddingTop: 10, textAlign: "right" }}>Claims</th>
              <th style={{ ...th, paddingTop: 10 }}>Flags</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const tone = verdictTone(r.verdict);
                return (
                  <tr key={r.id} onClick={() => onOpen(r.sourceId)} style={{ cursor: "pointer" }}>
                    <td style={{ ...td, maxWidth: 520 }}>
                      <div style={{ lineHeight: 1.45 }}>{r.title || `Source ${r.sourceId}`}</div>
                      <div style={{ fontFamily: mono, fontSize: 11.5, color: T.inkSoft, marginTop: 3 }}>
                        {r.journal} {r.year} {r.pmid ? `· PMID ${r.pmid}` : ""}
                      </div>
                    </td>
                    <td style={{ ...td, textAlign: "right", ...figures, fontWeight: 700 }}>{r.score}</td>
                    <td style={td}><Tag fg={tone.fg} bg={tone.bg}>{tone.label}</Tag></td>
                    {/* A report that produced nothing is not a failure, but it
                        is the difference between work done and work to review. */}
                    <td style={{ ...td, textAlign: "right", ...figures,
                      color: r.claims ? T.ink : T.inkSoft }}>{r.claims ?? 0}</td>
                    <td style={td}>
                      {(r.flags || []).slice(0, 3).map((f) => (
                        <Tag key={f} fg={T.bad} bg={T.badSoft}>{f.split(":")[0].replace(/_/g, " ")}</Tag>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ---- what this is ----------------------------------------------------------
   A page for the person who has just been handed the portal. The pipeline is
   drawn with the live numbers in it rather than as a picture of an idea: a
   diagram that says "Sources" teaches the shape once, and one that says "1,189
   sources" is worth opening again. */
const STAGES = [
  { key: "ncbi", label: "PubMed & PMC", what: "NCBI's own APIs — E-utilities, the OA service, BioC." },
  { key: "sources", label: "Sources", what: "A paper, chapter or guideline, deduped across every seed that found it." },
  { key: "reports", label: "Reports", what: "One appraisal under one rubric version, across ten modules." },
  { key: "claims", label: "Claims", what: "One finding, bound to a field the app records, carrying the sentence it came from." },
  { key: "published", label: "Published", what: "The only table the patient app reads. A row is here only after a reviewer has accepted it." },
];

const ENTITIES = [
  ["Seed", "A search strategy, stored as an object so a corpus is reproducible. Each one names the parts of the daily record it exists to inform, and carries the year floor the whole library is held to."],
  ["Run", "One execution of a seed. The cursor is committed after every batch, so a restart resumes where it stopped rather than starting again."],
  ["Source", "A paper, chapter or guideline. Identifiers are read only from the record's own list, never from the works it cites."],
  ["Citation", "A work a source cites. A reference work's bibliography has already been screened by a domain expert, which makes it a better seed than any keyword search."],
  ["Report", "The appraisal. Unique on (source, prompt version, rubric version), so changing the rubric adds a report rather than overwriting one a human has read."],
  ["Claim", "A relationship between two things a person could log. Its quote is searched for in the stored text; one that cannot be found is never stored at all."],
  ["Review", "Append-only. The current state lives on the row; who changed what, when, and what it said before lives here."],
  ["Published", "The trust boundary, as a table rather than a promise — which is why it can be tested: a claim carrying a nonce is created, not published, and the nonce is looked for in everything the app serves."],
];

const RULES = [
  ["Nothing is published by a machine", "Screening may be model-assisted. There is no path from extracted to published that does not pass through a person, and the state machine refuses it."],
  ["Every quote is verified in code", "Not asked for in a prompt. A module whose sentence cannot be found in the stored text scores zero; a claim whose sentence cannot be found is discarded before a reviewer sees it."],
  ["A grade is earned, not asserted", "Strong means a meta-analysis or two randomised trials, and it belongs to the pair rather than to one study — publishing a second trial moves the badge for everything under it."],
  ["Full text only where the licence allows", "Stored for the PMC Open Access subset alone. Patients are shown the reviewer's own words and a link, never the source's text."],
  ["A retraction un-publishes itself", "Every sync re-reads retraction status, and a withdrawal revokes the claims from that paper without waiting to be asked."],
];

function About({ summary, reports, claims, published }) {
  const counts = { ncbi: null, sources: summary?.total, reports, claims, published };
  return (
    <section>
      <H2>How Dalīl works</H2>
      {/* The pipeline. Arrows between stages rather than boxes in an SVG, so it
          reflows on a narrow screen instead of scrolling sideways. */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "stretch", gap: 8, marginBottom: 24 }}>
        {STAGES.map((stage, i) => (
          <React.Fragment key={stage.key}>
            {i > 0 && (
              <div style={{ display: "grid", placeItems: "center", color: T.lineStrong,
                fontSize: 22, minWidth: 18 }}>→</div>
            )}
            <div style={{ ...card, padding: "13px 15px", flex: "1 1 170px", minWidth: 170,
              borderTop: `3px solid ${i === STAGES.length - 1 ? T.good : T.accent}` }}>
              <div style={{ fontFamily: sans, fontSize: 11, fontWeight: 700, letterSpacing: "0.05em",
                textTransform: "uppercase", color: T.inkSoft }}>{stage.label}</div>
              <div style={{ fontFamily: sans, fontSize: 24, fontWeight: 700, color: T.ink,
                lineHeight: 1.25, ...figures }}>
                {counts[stage.key] === null || counts[stage.key] === undefined
                  ? <span style={{ fontSize: 15, color: T.inkSoft }}>upstream</span>
                  : counts[stage.key].toLocaleString()}
              </div>
              <p style={{ fontFamily: sans, fontSize: 12, lineHeight: 1.5, color: T.inkMid,
                margin: "6px 0 0" }}>{stage.what}</p>
            </div>
          </React.Fragment>
        ))}
      </div>

      <H2>What each thing is</H2>
      <div style={{ ...card, padding: "4px 18px", marginBottom: 24 }}>
        {ENTITIES.map(([name, what], i) => (
          <div key={name} style={{ display: "flex", gap: 18, padding: "13px 0", flexWrap: "wrap",
            borderTop: i ? `1px solid ${T.line}` : "none" }}>
            <div style={{ fontFamily: sans, fontSize: 13.5, fontWeight: 700, color: T.accent,
              width: 96, flexShrink: 0 }}>{name}</div>
            <p style={{ fontFamily: sans, fontSize: 13.5, lineHeight: 1.55, color: T.ink,
              margin: 0, flex: "1 1 320px" }}>{what}</p>
          </div>
        ))}
      </div>

      <H2>Rules that are code, not convention</H2>
      <div style={{ display: "grid", gap: 10,
        gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        {RULES.map(([name, what]) => (
          <div key={name} style={{ ...card, padding: 15, borderLeft: `3px solid ${T.good}` }}>
            <div style={{ fontFamily: sans, fontSize: 13.5, fontWeight: 700, color: T.ink,
              marginBottom: 5 }}>{name}</div>
            <p style={{ fontFamily: sans, fontSize: 12.5, lineHeight: 1.55, color: T.inkMid,
              margin: 0 }}>{what}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---- harvesting ----------------------------------------------------------- */
function Harvest({ queries, runs, job, onRun, busy, onRefresh }) {
  const actions = [
    ["anchor", "Anchor + references", "NBK459251 and the 55 papers it cites — the highest-yield seed there is."],
    ["seed", "Run a seed", "The next seed due, capped at 200 so a first look is never a bulk job."],
    ["enrich", "Check licences", "Licence and retraction for each source; full text for the open-access subset only."],
    ["appraise", "Appraise twenty", "The only job here that costs money, which is why it is asked for rather than run on a timer."],
    ["sweep", "Retraction sweep", "Re-read retraction status, and un-publish anything a withdrawal costs."],
  ];
  return (
    <section>
      <H2>Harvest</H2>

      <div style={{ display: "grid", gap: 10, marginBottom: 18,
        gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" }}>
        {actions.map(([id, label, note]) => (
          <div key={id} style={{ ...card, padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontFamily: sans, fontSize: 14, fontWeight: 700, color: T.ink }}>{label}</div>
            <p style={{ fontFamily: sans, fontSize: 12.5, lineHeight: 1.5, color: T.inkMid,
              margin: 0, flex: 1 }}>{note}</p>
            <Button onClick={() => onRun(id)} busy={busy}>Run</Button>
          </div>
        ))}
      </div>

      {job && (
        <div style={{ ...card, padding: "12px 16px", marginBottom: 18,
          borderLeft: `3px solid ${job.state === "failed" ? T.bad : job.state === "running" ? T.warn : T.good}` }}>
          <div style={{ fontFamily: sans, fontSize: 13.5, fontWeight: 700, color: T.ink }}>
            {job.name}{job.detail ? ` · ${job.detail}` : ""} — {job.state}
            {/* How long it has been going. Appraising twenty papers is minutes
                of work, and a panel that says only "running" cannot be told
                apart from one that has hung. */}
            <span style={{ fontWeight: 500, color: T.inkSoft, ...figures }}>
              {" · "}{elapsed(job.started_at, job.finished_at)}
            </span>
          </div>
          {job.error && <div style={{ fontFamily: mono, fontSize: 12, color: T.bad, marginTop: 6 }}>{job.error}</div>}
          {job.result && (
            <pre style={{ fontFamily: mono, fontSize: 12, color: T.inkMid, margin: "6px 0 0",
              whiteSpace: "pre-wrap" }}>{JSON.stringify(job.result)}</pre>
          )}
        </div>
      )}

      <H2 count={`${queries.length} seeds`}>Seeds</H2>
      <div style={{ ...card, overflow: "hidden", marginBottom: 24 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ background: T.raised }}>
            <th style={{ ...th, paddingTop: 10 }}>Seed</th>
            <th style={{ ...th, paddingTop: 10 }}>Informs</th>
            <th style={{ ...th, paddingTop: 10 }}>Covered to</th>
            <th style={{ ...th, paddingTop: 10 }}>Last run</th>
            <th style={{ ...th, paddingTop: 10 }} />
          </tr></thead>
          <tbody>
            {queries.map((q) => (
              <tr key={q.id}>
                <td style={{ ...td, fontWeight: 600 }}>{q.name}</td>
                <td style={td}>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    {(q.informs || []).map((f) => <Tag key={f}>{f}</Tag>)}
                  </div>
                </td>
                <td style={{ ...td, ...figures, whiteSpace: "nowrap" }}>
                  {q.highWater
                    ? <><span style={{ marginRight: 7 }}>{q.highWater}</span><Ago when={q.highWater} /></>
                    : <Tag fg={T.bad} bg={T.badSoft}>never run</Tag>}
                </td>
                <td style={{ ...td, ...figures, color: T.inkMid }}>
                  {q.lastRun ? `${q.lastRun.added} new of ${q.lastRun.fetched}` : "—"}
                </td>
                <td style={{ ...td, textAlign: "right" }}>
                  <Button kind="ghost" busy={busy} onClick={() => onRun("seed", q.id)}>Run</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <H2 count={`${runs.length}`}>Runs</H2>
      <div style={{ ...card, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ background: T.raised }}>
            <th style={{ ...th, paddingTop: 10 }}>Started</th>
            <th style={{ ...th, paddingTop: 10 }}>State</th>
            <th style={{ ...th, paddingTop: 10 }}>Progress</th>
            <th style={{ ...th, paddingTop: 10 }}>Fetched</th>
            <th style={{ ...th, paddingTop: 10 }}>New</th>
            <th style={{ ...th, paddingTop: 10 }}>Window</th>
          </tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td style={{ ...td, ...figures, color: T.inkMid }}>
                  {(r.startedAt || "").replace("T", " ").slice(0, 16)}
                </td>
                <td style={td}>
                  <Tag fg={r.state === "failed" ? T.bad : r.state === "done" ? T.good : T.warn}
                    bg={r.state === "failed" ? T.badSoft : r.state === "done" ? T.goodSoft : T.warnSoft}>
                    {r.state}
                  </Tag>
                </td>
                <td style={{ ...td, ...figures }}>
                  {r.cursor} / {r.cap && r.cap < r.total ? `${r.cap} of ${r.total}` : r.total}
                </td>
                <td style={{ ...td, ...figures }}>{r.fetched}</td>
                <td style={{ ...td, ...figures }}>{r.added}</td>
                <td style={{ ...td, ...figures, color: T.inkSoft, fontSize: 12 }}>
                  {r.edatFrom ? `${r.edatFrom} → ${r.edatTo}` : "everything"}
                </td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr><td style={{ ...td, color: T.inkSoft }} colSpan={6}>No runs yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const Placeholder = ({ icon: Icon, title, children }) => (
  <section>
    <h2 style={{ fontFamily: serif, fontSize: 24, fontWeight: 400, color: T.ink, margin: "0 0 16px" }}>{title}</h2>
    <div style={{ background: T.surface, border: `1px dashed ${T.lineStrong}`, borderRadius: 8,
      padding: 28, textAlign: "center" }}>
      <Icon size={20} color={T.inkSoft} />
      <p style={{ fontFamily: sans, fontSize: 14, color: T.inkMid, lineHeight: 1.55,
        margin: "10px auto 0", maxWidth: 460 }}>{children}</p>
    </div>
  </section>
);

/* ---- the shell ------------------------------------------------------------ */
// In the order the work happens: gather, look at what came back, appraise it,
// then decide. Queue sits last because nothing can be queued until a report
// has produced a claim.
const VIEWS = [
  ["corpus", "Corpus", Library],
  ["harvest", "Harvest", Download],
  ["reports", "Reports", FlaskConical],
  ["queue", "Queue", ListChecks],
  ["about", "How it works", Info],
];

export default function Portal() {
  const [me, setMe] = useState(undefined);          // undefined = still asking
  const [view, setView] = useState(() => (window.location.hash || "#corpus").slice(1));
  const [data, setData] = useState({ sources: [], summary: null });
  const [queries, setQueries] = useState([]);
  const [runs, setRuns] = useState([]);
  const [job, setJob] = useState(null);
  const [reportRows, setReportRows] = useState([]);
  const [reportMeta, setReportMeta] = useState({ total: 0, verdicts: {} });
  const [reportFilter, setReportFilter] = useState({ q: "", verdict: "", flagged: false, sort: "recent" });
  const [report, setReport] = useState(null);       // one source's full report
  const [queue, setQueue] = useState({ claims: [] });
  const [candidates, setCandidates] = useState(null);
  const [at, setAt] = useState(0);                  // where in the queue
  const [problems, setProblems] = useState([]);
  const [open, setOpen] = useState(null);           // the source in the panel
  const [filter, setFilter] = useState({ state: "", q: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { api.whoami().then((r) => setMe(r.signedIn ? r : null)).catch(() => setMe(null)); }, []);
  useEffect(() => {
    // window.*, not the bare globals: the smoke test runs this in a DOM that
    // does not put them on globalThis, and neither does a worker.
    const onHash = () => setView((window.location.hash || "#corpus").slice(1));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const mishap = useCallback((err) => {
    if (err instanceof SignedOut) setMe(null); else setError(err.message);
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [corpus, seeds, ran, made, waiting, loops, running] = await Promise.all([
        api.corpus(filter), api.queries(), api.runs(), api.reports(reportFilter),
        api.queue({ limit: 200 }), api.candidates(), api.jobs(),
      ]);
      // Ask who is working on every load, not only after starting something.
      // Polling used to begin when this tab started a job, so a reload — or a
      // job started from another tab — left the panel blank while the work
      // carried on, which reads as "it never finished".
      setJob(running.current || running.past?.[0] || null);
      setData({ sources: corpus.sources || [], summary: corpus.summary || null });
      setQueries(seeds.queries || []);
      setRuns(ran.runs || []);
      setReportRows(made.reports || []);
      setReportMeta({ total: made.total ?? (made.reports || []).length, verdicts: made.verdicts || {} });
      setQueue({ claims: waiting.claims || [], open: waiting.open,
                 published: waiting.published, signedIn: waiting.signedIn,
                 reviewer: waiting.reviewer });
      setCandidates(loops);
    } catch (err) {
      mishap(err);
    } finally {
      setLoading(false);
    }
  }, [filter, reportFilter, mishap]);
  useEffect(() => { if (me) load(); }, [me, load]);

  // While a job runs, poll it — and reload once it stops, because what it did
  // is visible in the corpus rather than in the job.
  useEffect(() => {
    if (!me || job?.state !== "running") return undefined;
    const timer = setInterval(async () => {
      try {
        const status = await api.jobs();
        const latest = status.current || status.past?.[0] || null;
        setJob(latest);
        if (latest && latest.state !== "running") load();
      } catch (err) { mishap(err); }
    }, 1500);
    return () => clearInterval(timer);
  }, [me, job?.state, load, mishap]);

  const run = useCallback(async (which, queryId) => {
    setError("");
    try {
      const call = { anchor: () => api.anchor(),
                     seed: () => api.seed({ queryId: queryId ?? null, max: 200 }),
                     enrich: () => api.enrich(60),
                     sweep: () => api.sweep(200),
                     appraise: () => api.appraise({ sourceId: queryId ?? null, limit: 20 }) }[which];
      const out = await call();
      if (out.started === false) setError(`Already running: ${out.busy?.name}. One job at a time.`);
      setJob(out.job || out.busy || null);
    } catch (err) { mishap(err); }
  }, [mishap]);

  const openSource = useCallback(async (id) => {
    try { setOpen(await api.source(id)); } catch (err) { mishap(err); }
  }, [mishap]);

  /** One reviewer decision. The display text is saved as its own edit first, so
      the audit shows what a person wrote separately from what they then did. */
  const decide = useCallback(async (claim, action, { display, reason }) => {
    setProblems([]);
    try {
      const wrote = (display || "").trim();
      if (action !== "reject" && wrote && wrote !== (claim.displayText || "")) {
        await api.reviewClaim(claim.id, { action: "edit", changes: { display_text: wrote },
                                          note: "wrote the patient-facing wording" });
      }
      const out = await api.reviewClaim(claim.id, { action, overrideReason: reason || "" });
      if (!out.ok) { setProblems(out.problems || []); return; }
      await load();
      setAt((i) => Math.max(0, i));      // the list shrank under us; stay in place
    } catch (err) { mishap(err); }
  }, [load, mishap]);

  const openReport = useCallback(async (sourceId) => {
    try {
      setReport(await api.report(sourceId));
      setOpen(null);
      window.location.hash = "#reports";
    } catch (err) { mishap(err); }
  }, [mishap]);

  // A finished appraisal should refresh the report you are looking at, not just
  // the list behind it.
  useEffect(() => {
    if (job?.state === "done" && job.name === "appraise" && report?.source?.id) {
      openReport(report.source.id);
    }
  }, [job?.state, job?.name]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (me === undefined) return <div style={{ minHeight: "100vh", background: T.bg }} />;
  if (me === null) return <SignIn onSignedIn={setMe} />;

  return (
    <div style={{ minHeight: "100vh", background: T.bg }}>
      <header style={{ background: T.surface, borderBottom: `1px solid ${T.line}`,
        padding: "0 24px", position: "sticky", top: 0, zIndex: 5 }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", display: "flex", alignItems: "center", gap: 22, height: 58 }}>
          <Lockup size={26} />
          <nav style={{ display: "flex", gap: 2 }}>
            {VIEWS.map(([id, label, Icon]) => {
              const on = view === id;
              return (
                <a key={id} href={`#${id}`} style={{ display: "inline-flex", alignItems: "center", gap: 6,
                  fontFamily: sans, fontSize: 13.5, fontWeight: on ? 700 : 500, textDecoration: "none",
                  color: on ? T.accent : T.inkMid, background: on ? T.accentSoft : "transparent",
                  padding: "7px 12px", borderRadius: 6 }}>
                  <Icon size={14} />{label}
                </a>
              );
            })}
          </nav>
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
            {me.authRequired === false
              ? <>
                  <span style={{ fontFamily: sans, fontSize: 12.5, color: T.inkSoft }}>{me.email}</span>
                  <Tag>sign-in off</Tag>
                </>
              : <>
                  <span style={{ fontFamily: sans, fontSize: 12.5, color: T.inkSoft }}>{me.email}</span>
                  <button onClick={async () => { await api.logout().catch(() => {}); setMe(null); }}
                    title="Sign out"
                    style={{ background: "none", border: "none", cursor: "pointer", color: T.inkSoft,
                      display: "grid", placeItems: "center", padding: 4 }}>
                    <LogOut size={15} />
                  </button>
                </>}
          </span>
        </div>
      </header>

      <main style={{ maxWidth: 1180, margin: "0 auto", padding: "28px 24px 60px" }}>
        {error && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", background: T.badSoft,
            border: `1px solid ${T.bad}22`, borderRadius: 6, padding: "10px 12px", marginBottom: 18 }}>
            <AlertTriangle size={14} color={T.bad} />
            <span style={{ fontFamily: sans, fontSize: 13, color: T.bad }}>{error}</span>
          </div>
        )}
        {view === "corpus" && (
          <Corpus data={data} loading={loading} onRefresh={load} filter={filter}
            setFilter={setFilter} onOpen={openSource} />
        )}
        {view === "harvest" && (
          <Harvest queries={queries} runs={runs} job={job} onRun={run}
            busy={job?.state === "running"} onRefresh={load} />
        )}
        {view === "about" && (
          <About summary={data.summary} reports={reportMeta.total}
            claims={queue.open} published={queue.published} />
        )}
        {view === "queue" && (
          <Queue data={queue} candidates={candidates} index={Math.min(at, Math.max(0, (queue.claims || []).length - 1))}
            problems={problems} busy={loading} onAct={decide}
            onSkip={(step) => setAt((i) => Math.max(0,
              Math.min((queue.claims || []).length - 1, i + step)))} />
        )}
        {view === "reports" && (report
          ? <ReportView data={report} onBack={() => setReport(null)}
              onAppraise={(id) => run("appraise", id)} busy={job?.state === "running"} />
          : <ReportList rows={reportRows} total={reportMeta.total} verdicts={reportMeta.verdicts}
              onOpen={openReport} filter={reportFilter} setFilter={setReportFilter}
              loading={loading} />
        )}
      </main>
      <SourcePanel source={open} onClose={() => setOpen(null)} onReport={openReport} />
    </div>
  );
}
