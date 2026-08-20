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

const query = (params) => {
  const q = Object.entries(params || {})
    .filter(([, v]) => v !== "" && v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return q ? `?${q}` : "";
};

export const api = {
  whoami: () => request("/auth/whoami"),
  login: (email, password) => request("/auth/login", { method: "POST", body: { email, password } }),
  logout: () => request("/auth/logout", { method: "POST" }),
  health: () => request("/healthz"),

  corpus: (params) => request(`/corpus${query(params)}`),
  source: (id) => request(`/source/${id}`),
  queries: () => request("/queries"),
  runs: () => request("/runs"),
  vocabulary: () => request("/vocabulary"),

  reports: () => request("/reports"),
  report: (sourceId) => request(`/report/${sourceId}`),

  queue: (params) => request(`/queue${query(params)}`),
  reviewClaim: (id, body) => request(`/claim/${id}/review`, { method: "POST", body }),
  audit: (id) => request(`/claim/${id}/audit`),
  published: () => request("/published"),
  candidates: () => request("/candidates"),

  // Long jobs answer immediately with a handle; the portal polls /jobs.
  jobs: () => request("/jobs"),
  appraise: (body) => request("/jobs/appraise", { method: "POST", body }),
  anchor: () => request("/jobs/anchor", { method: "POST" }),
  seed: (body) => request("/jobs/seed", { method: "POST", body }),
  enrich: (limit) => request(`/jobs/enrich${query({ limit })}`, { method: "POST" }),
  sweep: (limit) => request(`/jobs/sweep${query({ limit })}`, { method: "POST" }),
};
