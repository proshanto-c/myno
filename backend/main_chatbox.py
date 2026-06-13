"""
Chatbox-mode entrypoint for the Myno backend.

This file intentionally reuses the existing FastAPI app from main.py so patient
creation, chat orchestration, DB persistence, descriptors, adaptation state, and
TTS keep the same data flow. It only adds a lightweight chatbot-style page.

Run:
  uvicorn main_chatbox:app --host 0.0.0.0 --port 8080
"""
import json

from fastapi import HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from main import FEATURES, Descriptor, Patient, Session, Turn, _avg_cycle, app, claude


class ChatboxTurnIn(BaseModel):
    role: str
    text: str


class ChatboxChatIn(BaseModel):
    message: str
    turns: list[ChatboxTurnIn] = []


class ChatboxExtractIn(BaseModel):
    text: str
    context: str = ""
    blocked: list[str] = []
    categories: list[dict] = []


@app.post("/chatbox/patients/{pid}/chat")
async def chatbox_chat(pid: int, body: ChatboxChatIn):
    s = Session()
    p = s.get(Patient, pid)
    if not p:
        s.close()
        raise HTTPException(404, "no such patient")

    blacklist = p.blacklist or []
    blocked_labels = [FEATURES[f]["label"] for f in blacklist if f in FEATURES]
    descriptors = s.query(Descriptor).filter_by(patient_id=pid).order_by(Descriptor.created_at.desc()).limit(20).all()
    desc_lines = "; ".join(f'{d.concept}: "{d.phrase}"' for d in descriptors) or "none yet"
    db_history = (
        s.query(Turn)
        .filter_by(patient_id=pid)
        .order_by(Turn.created_at.desc())
        .limit(20)
        .all()
    )
    db_history = list(reversed(db_history))
    db_msgs = [{"role": t.role, "content": t.content} for t in db_history]
    client_msgs = [
        {
            "role": "assistant" if t.role == "assistant" else "user",
            "content": t.text.strip()[:1200],
        }
        for t in (body.turns or [])[-20:]
        if t.role in {"assistant", "user"} and t.text.strip()
    ]
    base_msgs = client_msgs or db_msgs
    recent_questions = [
        msg["content"].strip()
        for msg in base_msgs
        if msg["role"] == "assistant" and "?" in (msg["content"] or "")
    ][-6:]
    recent_question_lines = "\n".join(f"- {q}" for q in recent_questions) or "none"
    msgs = list(base_msgs)
    msgs.append({"role": "user", "content": body.message})
    avg_gap = _avg_cycle(s, pid)

    system = f"""You are Myno, a calm information-gathering PCOS companion.
Your job in this chatbox is to understand the patient's situation well enough to infer daily tracking markers at the end of the conversation.

EACH TURN:
- Briefly acknowledge what they said in their own words.
- Ask ONE new concrete follow-up question that gathers more patient-specific information: timing, duration, severity, cycle pattern, symptoms, triggers, recent changes, or what happened today.
- Prefer questions that help fill missing daily markers: period today, pain, mood, energy, sugar/cravings, bloating, hair growth/loss, and any personal marker they mention.
- Reuse the patient's vocabulary. Known phrasings -> {desc_lines}.
- Adapt to them. Current read: {json.dumps(p.adapt_state or {})}. Goals: {p.goals or []}. Avg tracked cycle: {avg_gap} days.

QUESTION STYLE:
- Do NOT ask "have you checked this with a doctor", "have you seen a clinician", or similar referral-style questions.
- Do NOT redirect the conversation to medical appointment logistics.
- If safety or diagnosis caveats are needed, keep them brief and still ask for more concrete information.

REPEAT AVOIDANCE:
- Recent questions already asked:
{recent_question_lines}
- Do NOT ask a question that is semantically the same as one of those recent questions.
- If the patient already answered a topic with "no", "none", "not really", "I don't know", or similar, treat that as answered and move to a different daily marker.
- If several markers remain, rotate to a new slot in this priority: period/timing, pain, mood, energy, cravings/sugar, bloating, hair/skin, personal marker.

HARD CONSTRAINTS:
- NEVER ask about, request, or volunteer anything in this blocked list: {blocked_labels or 'none'}.
- NEVER diagnose or say whether they have PCOS.
- No specific drug doses.
- Keep the reply under ~55 words.

Return ONLY JSON, no prose, no code fences:
{{"reply": str,
  "descriptors": [{{"concept": str, "phrase": str}}],
  "adapt": {{"tone": "gentle"|"neutral"|"upbeat", "length": "short"|"medium", "distress": 0-3}}
}}"""

    raw = await claude(system, msgs)
    reply, new_desc, adapt = "", [], {}
    try:
        a, b = raw.index("{"), raw.rindex("}")
        obj = json.loads(raw[a:b + 1])
        reply = obj.get("reply", "")
        new_desc = obj.get("descriptors", []) or []
        adapt = obj.get("adapt", {}) or {}
    except Exception:
        reply = raw

    s.add(Turn(patient_id=pid, role="user", content=body.message))
    s.add(Turn(patient_id=pid, role="assistant", content=reply))
    for d in new_desc[:5]:
        if d.get("concept") and d.get("phrase"):
            s.add(Descriptor(patient_id=pid, concept=d["concept"][:40], phrase=d["phrase"][:200]))
    if adapt:
        p.adapt_state = {**(p.adapt_state or {}), **adapt}
    s.commit()
    s.close()
    return {"reply": reply, "learned": new_desc, "adapt": adapt}


def _chatbox_extract_sys(blocked: list[str]) -> str:
    block_line = ", ".join(blocked) if blocked else "none"
    return (
        "You are Myno, converting the completed chatbox conversation into daily tracking markers. "
        "Infer values from the WHOLE conversation. Do not ask follow-up questions in this response.\n"
        "All numeric marker values MUST be integers from 0 to 10 inclusive.\n"
        "- pain: 0 means no pain, 5 moderate pain, 10 extreme pain.\n"
        "- mood: 0 means very low/distressed mood, 5 mixed or neutral mood, 10 very good/steady mood.\n"
        "- energy: 0 means depleted, 5 moderate energy, 10 very high energy.\n"
        "- sugar: 0 means no notable sugar intake/cravings, 5 moderate, 10 extreme/high.\n"
        "- For any personalized category with a scale, ALWAYS use "
        "{\"scale\":{\"value\":int,\"max\":10}} where value is 0-10. "
        "Use 10 as the most intense/highest amount/strongest presence for that category.\n"
        "- Use null for standard numeric fields that cannot be inferred. Use false for boolean fields not mentioned.\n"
        "- Keep personalized categories in the patient's own words, max 6 categories, stable lower_snake_case keys.\n"
        f"- NEVER create, infer, or ask about anything in this blocked list: {block_line}.\n"
        "Return ONLY JSON, no prose, no code fences: "
        "{\"period\":true|false|null,\"pain\":0-10|null,\"mood\":0-10|null,\"energy\":0-10|null,"
        "\"sugar\":0-10|null,\"hairGrowth\":bool,\"hairLoss\":bool,\"bloating\":bool,\"cravings\":bool,"
        "\"categories\":[{\"key\":str,\"label\":str,\"value\":str,\"scale\":{\"value\":int,\"max\":10}}],"
        "\"say\":str}."
    )


@app.post("/chatbox/extract")
async def chatbox_extract(body: ChatboxExtractIn):
    ctx = (body.context or "").strip()
    cats = json.dumps(body.categories or [])
    user = (
        (f"Conversation so far: {ctx}\n" if ctx else "")
        + f"Current personalized categories: {cats}\n\n"
        + f'Completed conversation to score: "{body.text}"'
    )
    raw = await claude(_chatbox_extract_sys(body.blocked or []), [{"role": "user", "content": user}], max_tokens=650)
    try:
        a, b = raw.index("{"), raw.rindex("}")
        return json.loads(raw[a:b + 1])
    except Exception:
        return {}


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

    .end {
      padding: 0 12px;
      border-color: var(--text);
      background: var(--text);
      color: #fff;
    }

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

    .workspace.chatting {
      grid-template-columns: minmax(0, 780px);
      justify-content: center;
    }

    .workspace.chatting .marker-pane {
      display: none;
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

    .missing-list {
      margin-top: 12px;
      display: grid;
      gap: 8px;
    }

    .missing-item {
      border: 1px solid #f1c9c5;
      border-radius: 10px;
      padding: 10px 11px;
      background: #fff8f7;
      color: #7d2a22;
      font-size: 13px;
      line-height: 1.35;
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
        <button id="endConversation" class="end" type="button">End chat</button>
      </div>
    </header>

    <main id="scroll">
      <div id="workspace" class="workspace chatting">
        <section class="chat-pane" aria-label="Conversation">
          <div id="messages" class="messages"></div>
        </section>

        <aside class="marker-pane" aria-label="Daily markers">
          <section class="marker-panel">
            <div class="marker-head">
              <div>
                <div class="marker-title">Daily markers</div>
                <div class="marker-subtitle">Inferred after the conversation and saved to today's log.</div>
              </div>
              <div id="markerStatus" class="marker-status">Waiting</div>
            </div>
            <div id="periodMarker"></div>
            <div id="standardMarkers" class="marker-list"></div>
            <div id="booleanMarkers"></div>
            <div id="missingPrompts" class="missing-list"></div>
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
      <div id="composerHint" class="hint">Answer Myno's current question. Press Enter to send. Shift+Enter adds a line break.</div>
    </div>
  </section>

  <script>
    const apiBase = location.pathname.startsWith("/api") || (location.pathname.startsWith("/chatbox") && location.port !== "8080") ? "/api" : "";
    const storageKey = "myno.chatbox.patientId";
    const markerStoragePrefix = "myno.chatbox.markers.";
    const today = new Date().toISOString().slice(0, 10);
    const openingQuestion = "Let's start today's check-in. Did your period start or continue today?";
    const answerPlaceholder = "Answer Myno's question...";
    const waitingPlaceholder = "Myno is preparing the next question...";
    const endedPlaceholder = "Chat ended. Adjust today's sliders in the marker panel.";
    const activeHint = "Answer Myno's current question. Press Enter to send. Shift+Enter adds a line break.";
    const waitingHint = "Myno is reading your answer and preparing the next question.";
    const endedHint = "Chat ended. Use the marker panel to adjust missing values or any slider that feels off.";
    const fieldFeature = {
      pain: "pain",
      mood: "mood",
      sugar: "diet",
      cravings: "diet",
      hairGrowth: "hair_skin",
      hairLoss: "hair_skin"
    };
    const sliderMarkers = [
      { key: "pain", label: "Pain", max: 10, words: ["none", "trace", "very mild", "mild", "noticeable", "moderate", "uncomfortable", "strong", "severe", "very severe", "extreme"] },
      { key: "mood", label: "Mood", max: 10, words: ["very low", "low", "heavy", "fragile", "mixed", "neutral", "settled", "steady", "good", "very good", "bright"] },
      { key: "energy", label: "Energy", max: 10, words: ["depleted", "drained", "very low", "low", "limited", "moderate", "usable", "steady", "good", "high", "very high"] },
      { key: "sugar", label: "Sugar / cravings", max: 10, words: ["none", "trace", "very low", "low", "some", "moderate", "noticeable", "high", "very high", "intense", "extreme"] }
    ];
    const booleanMarkers = [
      { key: "hairGrowth", label: "Hair growth" },
      { key: "hairLoss", label: "Hair loss" },
      { key: "bloating", label: "Bloating" },
      { key: "cravings", label: "Cravings" }
    ];

    const statusEl = document.getElementById("status");
    const workspaceEl = document.getElementById("workspace");
    const markerStatusEl = document.getElementById("markerStatus");
    const periodMarkerEl = document.getElementById("periodMarker");
    const standardMarkersEl = document.getElementById("standardMarkers");
    const booleanMarkersEl = document.getElementById("booleanMarkers");
    const categoryMarkersEl = document.getElementById("categoryMarkers");
    const missingPromptsEl = document.getElementById("missingPrompts");
    const messagesEl = document.getElementById("messages");
    const scrollEl = document.getElementById("scroll");
    const formEl = document.getElementById("form");
    const inputEl = document.getElementById("input");
    const sendEl = document.getElementById("send");
    const composerHintEl = document.getElementById("composerHint");
    const endConversationEl = document.getElementById("endConversation");
    const patientIdEl = document.getElementById("patientId");
    const loadPatientEl = document.getElementById("loadPatient");
    const newPatientEl = document.getElementById("newPatient");

    let patientId = localStorage.getItem(storageKey) || "";
    let patientReady = false;
    let busy = false;
    let entry = defaultEntry();
    let blockedKeys = [];
    let blockedLabels = [];
    let flash = {};
    let conversationEnded = false;
    let conversationTurns = [];
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
      sendEl.disabled = next || conversationEnded;
      inputEl.disabled = next || conversationEnded;
      endConversationEl.disabled = next || conversationEnded;
      if (!conversationEnded) {
        inputEl.placeholder = next ? waitingPlaceholder : answerPlaceholder;
        composerHintEl.textContent = next ? waitingHint : activeHint;
      }
    }

    function setConversationEnded(next) {
      conversationEnded = next;
      workspaceEl.classList.toggle("chatting", !next);
      endConversationEl.textContent = next ? "Chat ended" : "End chat";
      inputEl.placeholder = next ? endedPlaceholder : answerPlaceholder;
      composerHintEl.textContent = next ? endedHint : activeHint;
      sendEl.disabled = busy || next;
      inputEl.disabled = busy || next;
      endConversationEl.disabled = busy || next;
      if (!next) {
        setMarkerStatus("Waiting");
        clearNode(missingPromptsEl);
      }
    }

    function startNewConversation() {
      conversationTurns = [];
      clearNode(messagesEl);
      setConversationEnded(false);
      appendMessage("assistant", openingQuestion, "Question 1");
      conversationTurns.push({ role: "assistant", text: openingQuestion });
    }

    function currentTranscript() {
      return conversationTurns
        .map((turn) => `${turn.role === "user" ? "Patient" : "Myno"}: ${turn.text}`)
        .join("\n");
    }

    function missingFromFields(fields) {
      const missing = [];
      const add = (label, prompt) => missing.push({ label, prompt });
      if (fields.period == null) add("Period", "Set the period control to yes or no for today.");
      if (fields.pain == null && !isFieldBlocked("pain")) add("Pain", "Adjust the pain slider to your best 0-10 estimate.");
      if (fields.mood == null && !isFieldBlocked("mood")) add("Mood", "Adjust the mood slider to your best 0-10 estimate.");
      if (fields.energy == null) add("Energy", "Adjust the energy slider to your best 0-10 estimate.");
      if (fields.sugar == null && !isFieldBlocked("sugar")) add("Sugar / cravings", "Adjust the sugar/cravings slider to your best 0-10 estimate.");
      if (fields.bloating !== true) add("Bloating", "Turn this on if bloating or abdominal fullness happened today.");
      if (fields.hairGrowth !== true && fields.hairLoss !== true && !isFieldBlocked("hairGrowth")) add("Hair / skin", "Turn on the matching marker if hair growth, hair loss, acne, or skin changes should be tracked.");
      return missing.slice(0, 5);
    }

    function renderMissingPrompts(missing) {
      clearNode(missingPromptsEl);
      const items = missing.length
        ? missing
        : [{ label: "Review", prompt: "All required fields were inferred. Adjust any slider or checkbox that feels off." }];
      items.forEach((item) => {
        const node = document.createElement("div");
        node.className = "missing-item";
        node.textContent = `${item.label}: ${item.prompt}`;
        missingPromptsEl.appendChild(node);
      });
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

    function clamp10(value, fallback = 0) {
      const n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      return Math.max(0, Math.min(10, Math.round(n)));
    }

    function rescaleTo10(value, max, fallback = 0) {
      const n = Number(value);
      const m = Number(max);
      if (!Number.isFinite(n)) return fallback;
      if (!Number.isFinite(m) || m <= 0 || m === 10) return clamp10(n, fallback);
      return clamp10((n / m) * 10, fallback);
    }

    function normalizeScale(scale) {
      if (!scale || typeof scale.value !== "number") return null;
      return { value: rescaleTo10(scale.value, scale.max, 0), max: 10 };
    }

    function normalizeEntryScores(next) {
      return {
        ...next,
        pain: clamp10(next.pain, 0),
        mood: clamp10(next.mood, 5),
        energy: clamp10(next.energy, 5),
        sugar: clamp10(next.sugar, 5),
        categories: (Array.isArray(next.categories) ? next.categories : []).map((cat) => {
          const scale = normalizeScale(cat.scale);
          return scale ? { ...cat, scale } : { ...cat };
        })
      };
    }

    function defaultEntry() {
      return {
        date: today,
        period: null,
        pain: 0,
        mood: 5,
        energy: 5,
        sugar: 5,
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
      localStorage.setItem(markerKey(patientId), JSON.stringify(normalizeEntryScores(next)));
    }

    function normalizeLog(row) {
      return {
        date: row.date || today,
        period: row.period ?? null,
        pain: row.pain ?? 0,
        mood: row.mood ?? 5,
        energy: row.energy ?? 5,
        sugar: row.sugar ?? 5,
        hairGrowth: row.hair_growth ?? row.hairGrowth ?? false,
        hairLoss: row.hair_loss ?? row.hairLoss ?? false,
        bloating: row.bloating ?? false,
        cravings: row.cravings ?? false,
        note: row.note || "",
        categories: []
      };
    }

    function toLogPayload(next = entry) {
      const scored = normalizeEntryScores(next);
      return {
        date: scored.date,
        period: scored.period,
        pain: scored.pain,
        mood: scored.mood,
        energy: scored.energy,
        sugar: scored.sugar,
        hair_growth: !!scored.hairGrowth,
        hair_loss: !!scored.hairLoss,
        bloating: !!scored.bloating,
        cravings: !!scored.cravings,
        note: scored.note || ""
      };
    }

    function isFieldBlocked(key) {
      const feature = fieldFeature[key];
      return feature ? blockedKeys.includes(feature) : false;
    }

    function markerWord(marker, value) {
      if (marker.words) {
        const idx = Math.max(0, Math.min(marker.words.length - 1, Math.round((clamp10(value) / marker.max) * (marker.words.length - 1))));
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
      entry = normalizeEntryScores({ ...next, date: today });
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
      const initialValue = clamp10(value);
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
      updateValue(initialValue);

      row.append(label, valueEl);
      card.appendChild(row);

      const input = document.createElement("input");
      input.className = "marker-slider";
      input.type = "range";
      input.min = "0";
      input.max = String(marker.max);
      input.value = String(initialValue);
      input.style.background = sliderBackground(initialValue, marker.max);
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
          const value = clamp10(entry[marker.key], marker.key === "pain" ? 0 : 5);
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
          const scale = normalizeScale(cat.scale);
          if (scale) {
            addSliderCard(
              categoryMarkersEl,
              { key: cat.key, label: cat.label || cat.key, max: 10 },
              scale.value,
              (nextValue) => {
                entry = {
                  ...entry,
                  categories: (entry.categories || []).map((c) => c.key === cat.key ? { ...c, scale: { ...(c.scale || {}), value: clamp10(nextValue), max: 10 } } : c)
                };
                rememberEntry(entry);
              },
              (nextValue) => {
                const next = {
                  ...entry,
                  categories: (entry.categories || []).map((c) => c.key === cat.key ? { ...c, scale: { ...(c.scale || {}), value: clamp10(nextValue), max: 10 } } : c)
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
      entry = normalizeEntryScores({ ...defaultEntry(), ...readStoredEntry(id), date: today });
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
          entry = normalizeEntryScores({
            ...defaultEntry(),
            ...(found ? normalizeLog(found) : {}),
            ...stored,
            date: today,
            categories: Array.isArray(stored.categories) ? stored.categories : []
          });
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
          ...(normalizeScale(cat.scale)
            ? { scale: normalizeScale(cat.scale) }
            : {})
        }));
    }

    async function extractAndPersist(id, text) {
      setMarkerStatus("Reading");
      const base = {
        ...entry,
        note: (entry.note ? `${entry.note} ` : "") + text
      };

      const res = await fetch(api("/chatbox/extract"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
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
        const normalized = ["pain", "mood", "energy", "sugar"].includes(key) ? clamp10(value, key === "pain" ? 0 : 5) : value;
        if (entry[key] !== normalized) changed.push(key);
        next[key] = normalized;
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
      return { fields, changed };
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
      patientReady = true;
      await loadMarkers(patientId);
      startNewConversation();
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
      patientReady = true;
      await loadMarkers(patientId);
      startNewConversation();
      setStatus(`Patient ${patientId} ready`, "ready");
      return patientId;
    }

    async function ensurePatient() {
      if (patientId && patientReady) return patientId;
      if (patientId) return loadPatient(patientId);
      return createPatient();
    }

    async function sendMessage(message) {
      if (conversationEnded) return;
      const id = await ensurePatient();
      const priorTurns = conversationTurns.slice(-20);
      appendMessage("user", message);
      conversationTurns.push({ role: "user", text: message });
      setBusy(true);
      setStatus("Myno is thinking", "");

      try {
        const res = await fetch(api(`/chatbox/patients/${encodeURIComponent(id)}/chat`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, turns: priorTurns })
        });
        const data = await parseResponse(res);
        if (!res.ok) throw new Error(data.detail || "Chat request failed");

        const learned = Array.isArray(data.learned) && data.learned.length
          ? `Learned ${data.learned.length} descriptor${data.learned.length === 1 ? "" : "s"}`
          : "";
        appendMessage("assistant", data.reply || "", learned);
        conversationTurns.push({ role: "assistant", text: data.reply || "" });
        setStatus(`Patient ${id} ready`, "ready");
      } catch (err) {
        appendMessage("assistant", err.message || "Something went wrong.", "Request failed");
        setStatus("Backend error", "error");
      } finally {
        setBusy(false);
        if (!conversationEnded) inputEl.focus();
      }
    }

    async function endConversation() {
      if (busy) return;
      const id = await ensurePatient();
      const userTurns = conversationTurns.filter((turn) => turn.role === "user" && turn.text.trim());
      if (!userTurns.length) {
        appendMessage("assistant", "Please answer the current question first, then I can infer your markers.", "More information needed");
        return;
      }

      setBusy(true);
      setStatus("Inferring daily markers", "");
      setMarkerStatus("Inferring");

      try {
        const transcript = currentTranscript();
        const { fields } = await extractAndPersist(id, transcript);
        setConversationEnded(true);
        renderMissingPrompts(missingFromFields(fields || {}));

        const missing = missingFromFields(fields || {});
        const modelLead = fields?.say ? `${fields.say} ` : "";
        const prompt = missing.length
          ? `${modelLead}I inferred what I could and saved the standard log. Chat is now ended; please use the marker panel to adjust the missing sliders or controls yourself: ${missing.map((item) => item.label.toLowerCase()).join(", ")}.`
          : `${modelLead}I inferred today's marker scores and saved the standard log. Chat is now ended; please review the sliders and adjust anything that feels off.`;
        appendMessage("assistant", prompt, "Conversation ended");
        setStatus(`Patient ${id} ready`, "ready");
      } catch (err) {
        appendMessage("assistant", err.message || "I could not infer the final markers.", "Inference failed");
        setStatus("Inference error", "error");
        setMarkerStatus("Failed");
      } finally {
        setBusy(false);
        if (conversationEnded) endConversationEl.disabled = true;
        if (!conversationEnded) inputEl.focus();
      }
    }

    function resizeInput() {
      inputEl.style.height = "auto";
      inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
    }

    formEl.addEventListener("submit", (event) => {
      event.preventDefault();
      const message = inputEl.value.trim();
      if (!message || busy || conversationEnded) return;
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
      patientReady = false;
      createPatient().catch((err) => {
        setStatus(err.message || "Create failed", "error");
      });
    });

    endConversationEl.addEventListener("click", () => {
      endConversation().catch((err) => {
        appendMessage("assistant", err.message || "I could not end the conversation cleanly.", "Inference failed");
        setStatus("Inference error", "error");
      });
    });

    patientIdEl.value = patientId;
    setConversationEnded(false);
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
