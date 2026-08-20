/**
 * Talking to Dalīl.
 *
 * Same origin, so the session cookie travels on its own and CORS never applies.
 * Every mutating call carries X-Dalil, which the server requires — SameSite
 * already covers CSRF, and this makes a cross-site form post impossible to
 * construct even where a browser gets that wrong.
 */
// The portal is served from /dalil/, so its API lives one level in. nginx
// matches the longer prefix first, which is what keeps them apart.
const BASE = "/dalil/api";

export class SignedOut extends Error {
  constructor() { super("Signed out"); this.signedOut = true; }
}

async function request(path, { method = "GET", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (method !== "GET") headers["X-Dalil"] = "1";
  const res = await fetch(BASE + path, {
    method, headers, credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new SignedOut();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `${path} failed (${res.status})`);
  return data;
}

export const api = {
  whoami: () => request("/auth/whoami"),
  login: (email, password) => request("/auth/login", { method: "POST", body: { email, password } }),
  logout: () => request("/auth/logout", { method: "POST" }),
  corpus: () => request("/corpus"),
  health: () => request("/healthz"),
};
