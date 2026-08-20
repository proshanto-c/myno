import React, { useCallback, useEffect, useState } from "react";
import { LogOut, RefreshCw, AlertTriangle, Library, ListChecks, FlaskConical } from "lucide-react";
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
function Lockup({ size = 34, compact = false }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <BrandMark size={size} ring={T.accent} fill="#fff" />
      <div style={{ lineHeight: 1.15 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
          <span dir="rtl" style={{ fontFamily: head, fontWeight: 700,
            fontSize: size * 0.62, color: T.ink }}>دليل</span>
          <span style={{ fontFamily: serif, fontSize: size * 0.48, color: T.inkMid }}>Dalīl</span>
        </div>
        {!compact && (
          <div style={{ fontFamily: sans, fontSize: size * 0.3, color: T.inkSoft, marginTop: 3 }}>
            by Tawaazun
          </div>)}
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

function Corpus({ sources, loading, onRefresh }) {
  return (
    <section>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
        <h2 style={{ fontFamily: serif, fontSize: 24, fontWeight: 400, color: T.ink, margin: 0 }}>Corpus</h2>
        <span style={{ fontFamily: sans, fontSize: 13, color: T.inkSoft, ...figures }}>
          {sources.length} {sources.length === 1 ? "source" : "sources"}
        </span>
        <span style={{ marginLeft: "auto" }}>
          <Button kind="ghost" onClick={onRefresh} busy={loading}>
            <RefreshCw size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />Refresh
          </Button>
        </span>
      </header>

      {sources.length === 0 ? (
        <div style={{ background: T.surface, border: `1px dashed ${T.lineStrong}`, borderRadius: 8,
          padding: 28, textAlign: "center" }}>
          <Library size={20} color={T.inkSoft} />
          <p style={{ fontFamily: sans, fontSize: 14, color: T.inkMid, lineHeight: 1.55, margin: "10px auto 0", maxWidth: 460 }}>
            Nothing harvested yet. The first seed is the StatPearls chapter this condition is named
            after — <span style={{ fontFamily: mono, fontSize: 12.5 }}>NBK459251</span> — and the 55
            papers it cites.
          </p>
        </div>
      ) : (
        <div style={{ background: T.surface, border: `1px solid ${T.line}`, borderRadius: 8, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ background: T.raised }}>
              <th style={{ ...th, paddingTop: 10 }}>Title</th>
              <th style={{ ...th, paddingTop: 10 }}>Source</th>
              <th style={{ ...th, paddingTop: 10 }}>Year</th>
              <th style={{ ...th, paddingTop: 10 }}>Licence</th>
              <th style={{ ...th, paddingTop: 10 }}>State</th>
            </tr></thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id}>
                  <td style={{ ...td, maxWidth: 460 }}>
                    <div style={{ lineHeight: 1.45 }}>{s.title || "—"}</div>
                    <div style={{ fontFamily: mono, fontSize: 11.5, color: T.inkSoft, marginTop: 3 }}>
                      {s.pmid ? `PMID ${s.pmid}` : ""}{s.nbk ? `  ${s.nbk}` : ""}
                    </div>
                  </td>
                  <td style={{ ...td, color: T.inkMid }}>{s.journal || "—"}</td>
                  <td style={{ ...td, ...figures }}>{s.year || "—"}</td>
                  <td style={td}>{s.licence ? <Tag>{s.licence}</Tag> : <Tag>not open access</Tag>}</td>
                  <td style={td}>
                    {s.retracted
                      ? <Tag fg={T.bad} bg={T.badSoft}>retracted</Tag>
                      : <Tag>{s.screenState}</Tag>}
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
  ["queue", "Queue", ListChecks],
  ["reports", "Reports", FlaskConical],
];

export default function Portal() {
  const [me, setMe] = useState(undefined);          // undefined = still asking
  const [view, setView] = useState(() => (window.location.hash || "#corpus").slice(1));
  const [sources, setSources] = useState([]);
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

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      setSources((await api.corpus()).sources || []);
    } catch (err) {
      if (err instanceof SignedOut) setMe(null);
      else setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { if (me) load(); }, [me, load]);

  if (me === undefined) return <div style={{ minHeight: "100vh", background: T.bg }} />;
  if (me === null) return <SignIn onSignedIn={setMe} />;

  return (
    <div style={{ minHeight: "100vh", background: T.bg }}>
      <header style={{ background: T.surface, borderBottom: `1px solid ${T.line}`,
        padding: "0 24px", position: "sticky", top: 0, zIndex: 5 }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", display: "flex", alignItems: "center", gap: 22, height: 58 }}>
          <Lockup size={28} compact />
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
        {view === "corpus" && <Corpus sources={sources} loading={loading} onRefresh={load} />}
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
    </div>
  );
}
