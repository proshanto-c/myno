"""
Chatbox-mode entrypoint for the Myno backend.

This file intentionally reuses the existing FastAPI app from main.py so patient
creation, chat orchestration, DB persistence, descriptors, adaptation state, and
TTS keep the same data flow. It only adds a lightweight chatbot-style page.

Run:
  uvicorn main_chatbox:app --host 0.0.0.0 --port 8080
"""
from fastapi.responses import HTMLResponse

from main import app


CHATBOX_HTML = r"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Myno Chatbox</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --line: #d8dde6;
      --text: #172033;
      --muted: #647085;
      --user: #1f6feb;
      --assistant: #eef1f5;
      --danger: #b42318;
      --ok: #16794c;
      --shadow: 0 18px 50px rgba(20, 30, 50, 0.12);
    }

    * { box-sizing: border-box; }

    html, body {
      height: 100%;
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }

    body {
      display: grid;
      place-items: center;
      padding: 24px;
    }

    .shell {
      width: min(1180px, 100%);
      height: min(860px, calc(100vh - 48px));
      min-height: 560px;
      display: grid;
      grid-template-rows: auto 1fr auto;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 16px 18px;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.94);
    }

    .title {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .mark {
      width: 34px;
      height: 34px;
      display: grid;
      place-items: center;
      border-radius: 9px;
      background: var(--text);
      color: #fff;
      font-weight: 800;
      flex: 0 0 auto;
    }

    h1 {
      margin: 0;
      font-size: 17px;
      line-height: 1.2;
      letter-spacing: 0;
    }

    .subtitle {
      margin-top: 3px;
      color: var(--muted);
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .controls {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 34px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      font-size: 13px;
      background: #fff;
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--muted);
    }

    .status.ready .dot { background: var(--ok); }
    .status.error .dot { background: var(--danger); }

    .patient {
      width: 112px;
      height: 34px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--text);
      font: inherit;
      font-size: 13px;
      outline: none;
    }

    button {
      height: 34px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      color: var(--text);
      font: inherit;
      font-size: 13px;
      font-weight: 650;
      cursor: pointer;
    }

    button:hover { border-color: #aeb7c7; }
    button:disabled { cursor: not-allowed; opacity: 0.55; }

    .secondary { padding: 0 11px; }

    main {
      min-height: 0;
      overflow-y: auto;
      padding: 22px;
      background:
        linear-gradient(#ffffff 0, rgba(255, 255, 255, 0) 80px),
        var(--panel);
    }

    .messages {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .workspace {
      width: min(1120px, 100%);
      margin: 0 auto;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 330px;
      gap: 18px;
      align-items: start;
    }

    .chat-pane {
      min-width: 0;
    }

    .marker-pane {
      position: sticky;
      top: 0;
      display: grid;
      gap: 12px;
    }

    .marker-panel {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 14px;
      background: #fbfcfe;
    }

    .marker-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }

    .marker-title {
      font-size: 14px;
      font-weight: 800;
    }

    .marker-subtitle {
      margin-top: 3px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }

    .marker-status {
      color: var(--muted);
      font-size: 12px;
      text-align: right;
      white-space: nowrap;
    }

    .marker-list {
      display: grid;
      gap: 10px;
    }

    .marker-card {
      position: relative;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      background: #fff;
      transition: background-color .25s ease, border-color .25s ease, box-shadow .25s ease;
    }

    .marker-card.updated {
      border-color: #34a7ad;
      background: #effcfd;
      box-shadow: 0 0 0 3px rgba(52, 167, 173, 0.18);
    }

    .marker-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }

    .marker-label {
      min-width: 0;
      color: var(--text);
      font-size: 13px;
      font-weight: 750;
      overflow-wrap: anywhere;
    }

    .marker-value {
      color: var(--user);
      font-size: 13px;
      font-weight: 800;
      text-align: right;
      white-space: nowrap;
    }

    .marker-note {
      margin-top: 7px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }

    input.marker-slider {
      width: 100%;
      height: 8px;
      margin: 0;
      appearance: none;
      border-radius: 999px;
      background: linear-gradient(90deg, var(--user) 0%, var(--user) 50%, #dfe5ee 50%, #dfe5ee 100%);
      outline: none;
    }

    input.marker-slider::-webkit-slider-thumb {
      appearance: none;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 3px solid var(--user);
      background: #fff;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(31, 111, 235, 0.25);
    }

    input.marker-slider::-moz-range-thumb {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 3px solid var(--user);
      background: #fff;
      cursor: pointer;
    }

    .period-toggle,
    .boolean-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .marker-chip {
      min-height: 34px;
      padding: 0 10px;
      border-radius: 8px;
      border: 1px solid var(--line);
      color: var(--muted);
      background: #fff;
      font-size: 12px;
      font-weight: 750;
    }

    .marker-chip.active {
      border-color: var(--user);
      background: var(--user);
      color: #fff;
    }

    .empty-markers {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }

    .welcome {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 16px;
      color: var(--muted);
      background: #fbfcfe;
      line-height: 1.45;
      font-size: 14px;
    }

    .row {
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr);
      gap: 10px;
      align-items: start;
    }

    .row.user {
      grid-template-columns: minmax(0, 1fr) 34px;
    }

    .avatar {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: #dfe5ee;
      color: var(--text);
      font-size: 12px;
      font-weight: 800;
    }

    .user .avatar {
      background: var(--user);
      color: #fff;
    }

    .bubble {
      width: fit-content;
      max-width: min(680px, 100%);
      padding: 12px 14px;
      border-radius: 14px;
      background: var(--assistant);
      line-height: 1.5;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 15px;
    }

    .user .bubble {
      margin-left: auto;
      background: var(--user);
      color: #fff;
    }

    .meta {
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
    }

    .user .meta {
      text-align: right;
    }

    .composer-wrap {
      border-top: 1px solid var(--line);
      padding: 16px 18px;
      background: #fff;
    }

    .composer {
      width: min(780px, 100%);
      margin: 0 auto;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: end;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px;
      background: #fff;
    }

    textarea {
      width: 100%;
      max-height: 160px;
      min-height: 44px;
      resize: none;
      border: 0;
      outline: 0;
      padding: 10px 6px;
      color: var(--text);
      font: inherit;
      font-size: 15px;
      line-height: 1.45;
    }

    .send {
      width: 42px;
      height: 42px;
      padding: 0;
      border: 0;
      border-radius: 10px;
      background: var(--text);
      color: #fff;
      font-size: 20px;
      line-height: 1;
    }

    .hint {
      width: min(780px, 100%);
      margin: 8px auto 0;
      color: var(--muted);
      font-size: 12px;
      text-align: center;
    }

    @media (max-width: 720px) {
      body { padding: 0; }

      .shell {
        height: 100vh;
        min-height: 100vh;
        border: 0;
        border-radius: 0;
      }

      header {
        align-items: flex-start;
        flex-direction: column;
      }

      .controls {
        width: 100%;
        justify-content: flex-start;
      }

      .status {
        max-width: 100%;
      }

      main {
        padding: 16px 12px;
      }

      .composer-wrap {
        padding: 12px;
      }

      .workspace {
        grid-template-columns: 1fr;
      }

      .marker-pane {
        position: static;
      }
    }
  </style>
</head>
<body>
  <section class="shell" aria-label="Myno chatbox">
    <header>
      <div class="title">
        <div class="mark">M</div>
        <div>
          <h1>Myno Chatbox</h1>
          <div class="subtitle">Backend chat mode using the same patient, turn, descriptor, and adaptation flow.</div>
        </div>
      </div>
      <div class="controls">
        <div id="status" class="status"><span class="dot"></span><span>Starting</span></div>
        <input id="patientId" class="patient" inputmode="numeric" placeholder="Patient ID" aria-label="Patient ID" />
        <button id="loadPatient" class="secondary" type="button">Load</button>
        <button id="newPatient" class="secondary" type="button">New</button>
      </div>
    </header>

    <main id="scroll">
      <div class="workspace">
        <section class="chat-pane" aria-label="Conversation">
          <div id="messages" class="messages">
            <div class="welcome">
              Start a regular chat with Myno. Each message still goes to
              <code>/patients/{id}/chat</code>, and this chatbox also extracts daily markers through
              <code>/extract</code> so today's patient log can be updated as you talk.
            </div>
          </div>
        </section>

        <aside class="marker-pane" aria-label="Daily markers">
          <section class="marker-panel">
            <div class="marker-head">
              <div>
                <div class="marker-title">Daily markers</div>
                <div class="marker-subtitle">Updated from this chat and saved to today's log.</div>
              </div>
              <div id="markerStatus" class="marker-status">Waiting</div>
            </div>
            <div id="periodMarker"></div>
            <div id="standardMarkers" class="marker-list"></div>
            <div id="booleanMarkers"></div>
          </section>

          <section class="marker-panel">
            <div class="marker-head">
              <div>
                <div class="marker-title">Personal markers</div>
                <div class="marker-subtitle">In the patient's own words, with sliders when severity is inferred.</div>
              </div>
            </div>
            <div id="categoryMarkers" class="marker-list">
              <div class="empty-markers">Markers appear here when the patient mentions symptoms, patterns, or body signals.</div>
            </div>
          </section>
        </div>
      </div>
    </main>

    <div class="composer-wrap">
      <form id="form" class="composer">
        <textarea id="input" rows="1" placeholder="Message Myno..." autocomplete="off"></textarea>
        <button id="send" class="send" type="submit" aria-label="Send">↑</button>
      </form>
      <div class="hint">Press Enter to send. Shift+Enter adds a line break.</div>
    </div>
  </section>

  <script>
    const apiBase = location.pathname.startsWith("/api") ? "/api" : "";
    const storageKey = "myno.chatbox.patientId";
    const markerStoragePrefix = "myno.chatbox.markers.";
    const today = new Date().toISOString().slice(0, 10);
    const fieldFeature = {
      pain: "pain",
      mood: "mood",
      sugar: "diet",
      cravings: "diet",
      hairGrowth: "hair_skin",
      hairLoss: "hair_skin"
    };
    const sliderMarkers = [
      { key: "pain", label: "Pain", max: 10, words: ["none", "mild", "moderate", "strong", "severe"] },
      { key: "mood", label: "Mood", max: 4, words: ["low", "fragile", "mixed", "steady", "good"] },
      { key: "energy", label: "Energy", max: 4, words: ["spent", "low", "okay", "steady", "bright"] },
      { key: "sugar", label: "Sugar / cravings", max: 4, words: ["none", "low", "some", "high", "very high"] }
    ];
    const booleanMarkers = [
      { key: "hairGrowth", label: "Hair growth" },
      { key: "hairLoss", label: "Hair loss" },
      { key: "bloating", label: "Bloating" },
      { key: "cravings", label: "Cravings" }
    ];

    const statusEl = document.getElementById("status");
    const markerStatusEl = document.getElementById("markerStatus");
    const periodMarkerEl = document.getElementById("periodMarker");
    const standardMarkersEl = document.getElementById("standardMarkers");
    const booleanMarkersEl = document.getElementById("booleanMarkers");
    const categoryMarkersEl = document.getElementById("categoryMarkers");
    const messagesEl = document.getElementById("messages");
    const scrollEl = document.getElementById("scroll");
    const formEl = document.getElementById("form");
    const inputEl = document.getElementById("input");
    const sendEl = document.getElementById("send");
    const patientIdEl = document.getElementById("patientId");
    const loadPatientEl = document.getElementById("loadPatient");
    const newPatientEl = document.getElementById("newPatient");

    let patientId = localStorage.getItem(storageKey) || "";
    let busy = false;
    let entry = defaultEntry();
    let blockedKeys = [];
    let blockedLabels = [];
    let flash = {};
    const flashTimers = {};

    function api(path) {
      return `${apiBase}${path}`;
    }

    function setStatus(text, mode) {
      statusEl.className = `status ${mode || ""}`.trim();
      statusEl.lastElementChild.textContent = text;
    }

    function setMarkerStatus(text) {
      markerStatusEl.textContent = text;
    }

    function setBusy(next) {
      busy = next;
      sendEl.disabled = next;
      inputEl.disabled = next;
    }

    function appendMessage(role, text, meta) {
      const row = document.createElement("div");
      row.className = `row ${role}`;

      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.textContent = role === "user" ? "You" : "MY";

      const content = document.createElement("div");
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = text;
      content.appendChild(bubble);

      if (meta) {
        const metaEl = document.createElement("div");
        metaEl.className = "meta";
        metaEl.textContent = meta;
        content.appendChild(metaEl);
      }

      if (role === "user") {
        row.append(content, avatar);
      } else {
        row.append(avatar, content);
      }

      messagesEl.appendChild(row);
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }

    async function parseResponse(res) {
      const text = await res.text();
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        return { detail: text || res.statusText };
      }
    }

    function defaultEntry() {
      return {
        date: today,
        period: null,
        pain: 0,
        mood: 2,
        energy: 2,
        sugar: 2,
        hairGrowth: false,
        hairLoss: false,
        bloating: false,
        cravings: false,
        note: "",
        categories: []
      };
    }

    function markerKey(id) {
      return `${markerStoragePrefix}${id}.${today}`;
    }

    function readStoredEntry(id) {
      try {
        return JSON.parse(localStorage.getItem(markerKey(id)) || "null") || {};
      } catch {
        return {};
      }
    }

    function rememberEntry(next = entry) {
      if (!patientId) return;
      localStorage.setItem(markerKey(patientId), JSON.stringify(next));
    }

    function normalizeLog(row) {
      return {
        date: row.date || today,
        period: row.period ?? null,
        pain: row.pain ?? 0,
        mood: row.mood ?? 2,
        energy: row.energy ?? 2,
        sugar: row.sugar ?? 2,
        hairGrowth: row.hair_growth ?? row.hairGrowth ?? false,
        hairLoss: row.hair_loss ?? row.hairLoss ?? false,
        bloating: row.bloating ?? false,
        cravings: row.cravings ?? false,
        note: row.note || "",
        categories: []
      };
    }

    function toLogPayload(next = entry) {
      return {
        date: next.date,
        period: next.period,
        pain: next.pain,
        mood: next.mood,
        energy: next.energy,
        sugar: next.sugar,
        hair_growth: !!next.hairGrowth,
        hair_loss: !!next.hairLoss,
        bloating: !!next.bloating,
        cravings: !!next.cravings,
        note: next.note || ""
      };
    }

    function isFieldBlocked(key) {
      const feature = fieldFeature[key];
      return feature ? blockedKeys.includes(feature) : false;
    }

    function markerWord(marker, value) {
      if (marker.words) {
        const idx = Math.max(0, Math.min(marker.words.length - 1, Math.round((value / marker.max) * (marker.words.length - 1))));
        return marker.words[idx];
      }
      return "";
    }

    function sliderBackground(value, max) {
      const pct = Math.max(0, Math.min(100, (Number(value || 0) / Number(max || 1)) * 100));
      return `linear-gradient(90deg, var(--user) ${pct}%, #dfe5ee ${pct}%)`;
    }

    function clearNode(node) {
      while (node.firstChild) node.removeChild(node.firstChild);
    }

    function lightUp(keys) {
      keys.filter(Boolean).forEach((key) => {
        flash[key] = true;
        clearTimeout(flashTimers[key]);
        flashTimers[key] = setTimeout(() => {
          delete flash[key];
          renderMarkers();
        }, 1700);
      });
      renderMarkers();
    }

    async function persistEntry(next = entry) {
      entry = { ...next, date: today };
      rememberEntry(entry);
      renderMarkers();
      if (!patientId) return;
      setMarkerStatus("Saving");
      const res = await fetch(api(`/patients/${encodeURIComponent(patientId)}/logs`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toLogPayload(entry))
      });
      if (!res.ok) {
        const data = await parseResponse(res);
        throw new Error(data.detail || "Could not save log");
      }
      setMarkerStatus("Saved");
    }

    function addSliderCard(parent, marker, value, onInput, onCommit, note = "") {
      const card = document.createElement("div");
      card.className = `marker-card ${flash[marker.key] ? "updated" : ""}`.trim();

      const row = document.createElement("div");
      row.className = "marker-row";

      const label = document.createElement("div");
      label.className = "marker-label";
      label.textContent = marker.label;

      const valueEl = document.createElement("div");
      valueEl.className = "marker-value";
      const updateValue = (nextValue) => {
        const word = markerWord(marker, nextValue);
        valueEl.textContent = word ? `${word} · ${nextValue}/${marker.max}` : `${nextValue}/${marker.max}`;
      };
      updateValue(value);

      row.append(label, valueEl);
      card.appendChild(row);

      const input = document.createElement("input");
      input.className = "marker-slider";
      input.type = "range";
      input.min = "0";
      input.max = String(marker.max);
      input.value = String(value);
      input.style.background = sliderBackground(value, marker.max);
      input.addEventListener("input", () => {
        const nextValue = Number(input.value);
        input.style.background = sliderBackground(nextValue, marker.max);
        updateValue(nextValue);
        onInput(nextValue);
      });
      input.addEventListener("change", () => onCommit(Number(input.value)));
      card.appendChild(input);

      if (note) {
        const noteEl = document.createElement("div");
        noteEl.className = "marker-note";
        noteEl.textContent = note;
        card.appendChild(noteEl);
      }

      parent.appendChild(card);
    }

    function addPeriodMarker() {
      clearNode(periodMarkerEl);
      const card = document.createElement("div");
      card.className = `marker-card ${flash.period ? "updated" : ""}`.trim();

      const row = document.createElement("div");
      row.className = "marker-row";
      const label = document.createElement("div");
      label.className = "marker-label";
      label.textContent = "Period today";
      const value = document.createElement("div");
      value.className = "marker-value";
      value.textContent = entry.period === true ? "yes" : entry.period === false ? "no" : "not set";
      row.append(label, value);
      card.appendChild(row);

      const toggle = document.createElement("div");
      toggle.className = "period-toggle";
      [["Yes", true], ["No", false]].forEach(([labelText, val]) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `marker-chip ${entry.period === val ? "active" : ""}`.trim();
        btn.textContent = labelText;
        btn.addEventListener("click", () => {
          entry = { ...entry, period: val };
          lightUp(["period"]);
          persistEntry(entry).catch((err) => setMarkerStatus(err.message || "Save failed"));
        });
        toggle.appendChild(btn);
      });
      card.appendChild(toggle);
      periodMarkerEl.appendChild(card);
    }

    function renderMarkers() {
      addPeriodMarker();
      clearNode(standardMarkersEl);
      clearNode(booleanMarkersEl);
      clearNode(categoryMarkersEl);

      sliderMarkers
        .filter((marker) => !isFieldBlocked(marker.key))
        .forEach((marker) => {
          const value = Number(entry[marker.key] ?? 0);
          addSliderCard(
            standardMarkersEl,
            marker,
            value,
            (nextValue) => { entry = { ...entry, [marker.key]: nextValue }; rememberEntry(entry); },
            (nextValue) => persistEntry({ ...entry, [marker.key]: nextValue }).catch((err) => setMarkerStatus(err.message || "Save failed"))
          );
        });

      const visibleBooleans = booleanMarkers.filter((marker) => !isFieldBlocked(marker.key));
      if (visibleBooleans.length) {
        const card = document.createElement("div");
        card.className = "marker-card";
        const row = document.createElement("div");
        row.className = "marker-row";
        const label = document.createElement("div");
        label.className = "marker-label";
        label.textContent = "Other signals";
        row.appendChild(label);
        card.appendChild(row);

        const grid = document.createElement("div");
        grid.className = "boolean-grid";
        visibleBooleans.forEach((marker) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = `marker-chip ${entry[marker.key] ? "active" : ""} ${flash[marker.key] ? "updated" : ""}`.trim();
          btn.textContent = marker.label;
          btn.addEventListener("click", () => {
            entry = { ...entry, [marker.key]: !entry[marker.key] };
            lightUp([marker.key]);
            persistEntry(entry).catch((err) => setMarkerStatus(err.message || "Save failed"));
          });
          grid.appendChild(btn);
        });
        card.appendChild(grid);
        booleanMarkersEl.appendChild(card);
      }

      const cats = Array.isArray(entry.categories) ? entry.categories : [];
      if (!cats.length) {
        const empty = document.createElement("div");
        empty.className = "empty-markers";
        empty.textContent = "Markers appear here when the patient mentions symptoms, patterns, or body signals.";
        categoryMarkersEl.appendChild(empty);
      } else {
        cats.forEach((cat) => {
          const scale = cat.scale && typeof cat.scale.value === "number" && cat.scale.max > 0 ? cat.scale : null;
          if (scale) {
            addSliderCard(
              categoryMarkersEl,
              { key: cat.key, label: cat.label || cat.key, max: scale.max },
              scale.value,
              (nextValue) => {
                entry = {
                  ...entry,
                  categories: (entry.categories || []).map((c) => c.key === cat.key ? { ...c, scale: { ...(c.scale || {}), value: nextValue, max: scale.max } } : c)
                };
                rememberEntry(entry);
              },
              (nextValue) => {
                const next = {
                  ...entry,
                  categories: (entry.categories || []).map((c) => c.key === cat.key ? { ...c, scale: { ...(c.scale || {}), value: nextValue, max: scale.max } } : c)
                };
                entry = next;
                rememberEntry(entry);
                setMarkerStatus("Saved locally");
              },
              cat.value || ""
            );
          } else {
            const card = document.createElement("div");
            card.className = `marker-card ${flash[cat.key] ? "updated" : ""}`.trim();
            const row = document.createElement("div");
            row.className = "marker-row";
            const label = document.createElement("div");
            label.className = "marker-label";
            label.textContent = cat.label || cat.key;
            const value = document.createElement("div");
            value.className = "marker-value";
            value.textContent = cat.value || "noted";
            row.append(label, value);
            card.appendChild(row);
            categoryMarkersEl.appendChild(card);
          }
        });
      }
    }

    async function loadMarkers(id) {
      entry = { ...defaultEntry(), ...readStoredEntry(id), date: today };
      renderMarkers();
      setMarkerStatus("Loading");

      try {
        const blRes = await fetch(api(`/patients/${encodeURIComponent(id)}/blacklist`));
        if (blRes.ok) {
          const bl = await parseResponse(blRes);
          blockedKeys = Array.isArray(bl.blacklist) ? bl.blacklist : [];
          blockedLabels = blockedKeys.map((key) => bl.features?.[key]?.label).filter(Boolean);
        }
      } catch {
        blockedKeys = [];
        blockedLabels = [];
      }

      try {
        const res = await fetch(api(`/patients/${encodeURIComponent(id)}/logs`));
        const rows = await parseResponse(res);
        if (res.ok && Array.isArray(rows)) {
          const found = rows.find((row) => row.date === today);
          const stored = readStoredEntry(id);
          entry = {
            ...defaultEntry(),
            ...(found ? normalizeLog(found) : {}),
            ...stored,
            date: today,
            categories: Array.isArray(stored.categories) ? stored.categories : []
          };
        }
        setMarkerStatus("Ready");
      } catch {
        setMarkerStatus("Local only");
      }
      renderMarkers();
    }

    function cleanCategories(categories) {
      return (Array.isArray(categories) ? categories : [])
        .filter((cat) => cat && cat.key && cat.label)
        .slice(0, 6)
        .map((cat) => ({
          key: String(cat.key).slice(0, 48),
          label: String(cat.label).slice(0, 80),
          value: cat.value ? String(cat.value).slice(0, 160) : "",
          ...(cat.scale && typeof cat.scale.value === "number" && cat.scale.max > 0
            ? { scale: { value: Number(cat.scale.value), max: Number(cat.scale.max) } }
            : {})
        }));
    }

    async function extractAndPersist(id, message) {
      setMarkerStatus("Reading");
      const base = {
        ...entry,
        note: (entry.note ? `${entry.note} ` : "") + message
      };

      const res = await fetch(api("/extract"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: message,
          context: entry.note || "",
          blocked: blockedLabels,
          categories: entry.categories || []
        })
      });
      const fields = await parseResponse(res);
      if (!res.ok) throw new Error(fields.detail || "Marker extraction failed");

      const next = { ...base };
      const changed = [];
      const apply = (key, value) => {
        if (value === null || value === undefined || isFieldBlocked(key)) return;
        if (entry[key] !== value) changed.push(key);
        next[key] = value;
      };

      apply("period", fields.period);
      apply("pain", fields.pain);
      apply("mood", fields.mood);
      apply("energy", fields.energy);
      apply("sugar", fields.sugar);
      apply("hairGrowth", fields.hairGrowth || entry.hairGrowth);
      apply("hairLoss", fields.hairLoss || entry.hairLoss);
      apply("bloating", fields.bloating || entry.bloating);
      apply("cravings", fields.cravings || entry.cravings);

      if (Array.isArray(fields.categories)) {
        const previous = Object.fromEntries((entry.categories || []).map((cat) => [cat.key, JSON.stringify([cat.value, cat.scale?.value])]));
        next.categories = cleanCategories(fields.categories);
        next.categories.forEach((cat) => {
          if (previous[cat.key] !== JSON.stringify([cat.value, cat.scale?.value])) changed.push(cat.key);
        });
      }

      await persistEntry(next);
      lightUp(changed);
    }

    async function createPatient() {
      setStatus("Creating patient", "");
      const res = await fetch(api("/patients"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Chatbox User",
          goals: ["chatbox conversation"]
        })
      });
      const data = await parseResponse(res);
      if (!res.ok) throw new Error(data.detail || "Could not create patient");

      patientId = String(data.id);
      patientIdEl.value = patientId;
      localStorage.setItem(storageKey, patientId);
      await loadMarkers(patientId);
      setStatus(`Patient ${patientId} ready`, "ready");
      return patientId;
    }

    async function loadPatient(id) {
      if (!id) return createPatient();

      setStatus(`Loading patient ${id}`, "");
      const res = await fetch(api(`/patients/${encodeURIComponent(id)}`));
      const data = await parseResponse(res);
      if (!res.ok) throw new Error(data.detail || `No patient ${id}`);

      patientId = String(data.id);
      patientIdEl.value = patientId;
      localStorage.setItem(storageKey, patientId);
      await loadMarkers(patientId);
      setStatus(`Patient ${patientId} ready`, "ready");
      return patientId;
    }

    async function ensurePatient() {
      if (patientId) return loadPatient(patientId);
      return createPatient();
    }

    async function sendMessage(message) {
      const id = await ensurePatient();
      appendMessage("user", message);
      setBusy(true);
      setStatus("Myno is thinking", "");
      const markerPromise = extractAndPersist(id, message).catch((err) => {
        setMarkerStatus(err.message || "Markers skipped");
      });

      try {
        const res = await fetch(api(`/patients/${encodeURIComponent(id)}/chat`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message })
        });
        const data = await parseResponse(res);
        if (!res.ok) throw new Error(data.detail || "Chat request failed");

        const learned = Array.isArray(data.learned) && data.learned.length
          ? `Learned ${data.learned.length} descriptor${data.learned.length === 1 ? "" : "s"}`
          : "";
        appendMessage("assistant", data.reply || "", learned);
        await markerPromise;
        setStatus(`Patient ${id} ready`, "ready");
      } catch (err) {
        appendMessage("assistant", err.message || "Something went wrong.", "Request failed");
        setStatus("Backend error", "error");
      } finally {
        setBusy(false);
        inputEl.focus();
      }
    }

    function resizeInput() {
      inputEl.style.height = "auto";
      inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
    }

    formEl.addEventListener("submit", (event) => {
      event.preventDefault();
      const message = inputEl.value.trim();
      if (!message || busy) return;
      inputEl.value = "";
      resizeInput();
      sendMessage(message);
    });

    inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        formEl.requestSubmit();
      }
    });

    inputEl.addEventListener("input", resizeInput);

    loadPatientEl.addEventListener("click", () => {
      const nextId = patientIdEl.value.trim();
      loadPatient(nextId).catch((err) => {
        setStatus(err.message || "Load failed", "error");
      });
    });

    newPatientEl.addEventListener("click", () => {
      localStorage.removeItem(storageKey);
      patientId = "";
      createPatient().catch((err) => {
        setStatus(err.message || "Create failed", "error");
      });
    });

    patientIdEl.value = patientId;
    renderMarkers();
    ensurePatient().catch((err) => {
      setStatus(err.message || "Backend unavailable", "error");
    });
    inputEl.focus();
  </script>
</body>
</html>
"""


@app.get("/", include_in_schema=False)
def chatbox_root():
    return HTMLResponse(CHATBOX_HTML)


@app.get("/chatbox", include_in_schema=False)
def chatbox_page():
    return HTMLResponse(CHATBOX_HTML)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main_chatbox:app", host="0.0.0.0", port=8080)
