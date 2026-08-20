import React, { useCallback, useEffect, useState } from "react";
import { LogOut, RefreshCw, AlertTriangle, Library, ListChecks, FlaskConical, Download } from "lucide-react";
import { BrandMark, Brand } from "../brand.jsx";
import { T, serif, sans, head, mono, figures } from "./theme";
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

function Corpus({ data, loading, onRefresh, filter, setFilter, onOpen }) {
  const sources = data.sources || [];
  return (
    <section>
      <H2 count={`${sources.length} shown`}>Corpus</H2>
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
function SourcePanel({ source, onClose }) {
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
        {link && (
          <p style={{ margin: "0 0 18px" }}>
            <a href={link} target="_blank" rel="noreferrer"
              style={{ fontFamily: sans, fontSize: 13.5, color: T.accent }}>Open at NCBI →</a>
          </p>
        )}

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

/* ---- harvesting ----------------------------------------------------------- */
function Harvest({ queries, runs, job, onRun, busy, onRefresh }) {
  const actions = [
    ["anchor", "Anchor + references", "NBK459251 and the 55 papers it cites — the highest-yield seed there is."],
    ["seed", "Run a seed", "The next seed due, capped at 200 so a first look is never a bulk job."],
    ["enrich", "Check licences", "Licence and retraction for each source; full text for the open-access subset only."],
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
                <td style={{ ...td, ...figures, color: q.highWater ? T.ink : T.inkSoft }}>
                  {q.highWater || "never run"}
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
const VIEWS = [
  ["corpus", "Corpus", Library],
  ["harvest", "Harvest", Download],
  ["queue", "Queue", ListChecks],
  ["reports", "Reports", FlaskConical],
];

export default function Portal() {
  const [me, setMe] = useState(undefined);          // undefined = still asking
  const [view, setView] = useState(() => (window.location.hash || "#corpus").slice(1));
  const [data, setData] = useState({ sources: [], summary: null });
  const [queries, setQueries] = useState([]);
  const [runs, setRuns] = useState([]);
  const [job, setJob] = useState(null);
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
      const [corpus, seeds, ran] = await Promise.all([
        api.corpus(filter), api.queries(), api.runs(),
      ]);
      setData({ sources: corpus.sources || [], summary: corpus.summary || null });
      setQueries(seeds.queries || []);
      setRuns(ran.runs || []);
    } catch (err) {
      mishap(err);
    } finally {
      setLoading(false);
    }
  }, [filter, mishap]);
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
                     sweep: () => api.sweep(200) }[which];
      const out = await call();
      if (out.started === false) setError(`Already running: ${out.busy?.name}. One job at a time.`);
      setJob(out.job || out.busy || null);
    } catch (err) { mishap(err); }
  }, [mishap]);

  const openSource = useCallback(async (id) => {
    try { setOpen(await api.source(id)); } catch (err) { mishap(err); }
  }, [mishap]);

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
              ? <Tag fg={T.warn} bg={T.warnSoft}>sign-in off</Tag>
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
        {view === "queue" && (
          <Placeholder icon={ListChecks} title="Queue">
            Claims waiting to be reviewed will appear here. Nothing reaches a patient until someone
            signs it off.
          </Placeholder>
        )}
        {view === "reports" && (
          <Placeholder icon={FlaskConical} title="Reports">
            One appraisal per source: the modules, what scored what, and the quote behind every
            finding.
          </Placeholder>
        )}
      </main>
      <SourcePanel source={open} onClose={() => setOpen(null)} />
    </div>
  );
}
