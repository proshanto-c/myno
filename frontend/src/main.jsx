import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

// The app talks to a key-value `window.storage` (provided by the host in the
// Claude artifact runtime). For the standalone web build, back it with
// localStorage so a patient's profile, logs and settings persist on the device.
if (!window.storage) {
  window.storage = {
    async get(k) { const v = localStorage.getItem(k); return v == null ? null : { key: k, value: v }; },
    async set(k, v) { localStorage.setItem(k, v); return { key: k, value: v }; },
    async delete(k) { localStorage.removeItem(k); return { key: k, deleted: true }; },
    async list(prefix = "") { const keys = []; for (let i = 0; i < localStorage.length; i++) { const kk = localStorage.key(i); if (kk.startsWith(prefix)) keys.push(kk); } return { keys }; },
  };
}

createRoot(document.getElementById("root")).render(<App />);
