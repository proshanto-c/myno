"""
Myno backend — orchestration + persistence.

Responsibilities:
  * Postgres-backed storage for patients, daily logs, the patient's own
    vocabulary ("personal descriptors"), a feature blacklist, conversation
    history, and an adaptation state.
  * A /chat endpoint that drives the conversation: it knows general PCOS facts,
    asks the next relevant question, reuses the patient's own words, ADAPTS to
    them, and NEVER asks about blacklisted features. Claude is the LLM.
  * Thin /tts proxy so the frontend has a single origin.

Run via docker-compose (see docker-compose.yml). Env:
  DATABASE_URL, ANTHROPIC_API_KEY, TTS_URL
"""
import os, json, datetime as dt
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import (create_engine, Column, Integer, String, Boolean, Float,
                        Date, DateTime, ForeignKey, JSON, text)
from sqlalchemy.orm import declarative_base, sessionmaker, relationship

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql+psycopg2://myno:myno@db:5432/myno")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
TTS_URL = os.environ.get("TTS_URL", "http://tts:8001")
ANTHROPIC_MODEL = "claude-sonnet-4-6"

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
Session = sessionmaker(bind=engine, autoflush=False)
Base = declarative_base()

# ---------------------------------------------------------------- models
class Patient(Base):
    __tablename__ = "patients"
    id = Column(Integer, primary_key=True)
    name = Column(String, default="")
    age = Column(Integer, nullable=True)
    menarche_age = Column(Integer, nullable=True)
    height_cm = Column(Float, nullable=True)
    weight_kg = Column(Float, nullable=True)
    family_history = Column(Boolean, default=False)
    acne = Column(Boolean, default=False)
    skin_darkening = Column(Boolean, default=False)
    weight_gain = Column(Boolean, default=False)
    goals = Column(JSON, default=list)
    integrations = Column(JSON, default=list)
    blacklist = Column(JSON, default=list)          # blocked feature keys
    adapt_state = Column(JSON, default=dict)        # inferred prefs (tone, length, distress)
    created_at = Column(DateTime, default=dt.datetime.utcnow)
    logs = relationship("DailyLog", back_populates="patient", cascade="all,delete")
    descriptors = relationship("Descriptor", back_populates="patient", cascade="all,delete")
    turns = relationship("Turn", back_populates="patient", cascade="all,delete")

class DailyLog(Base):
    __tablename__ = "daily_logs"
    id = Column(Integer, primary_key=True)
    patient_id = Column(Integer, ForeignKey("patients.id"))
    date = Column(Date)
    period = Column(Boolean, nullable=True)
    pain = Column(Integer, nullable=True)
    sugar = Column(Integer, nullable=True)
    mood = Column(Integer, nullable=True)
    energy = Column(Integer, nullable=True)
    hair_growth = Column(Boolean, default=False)
    hair_loss = Column(Boolean, default=False)
    bloating = Column(Boolean, default=False)
    cravings = Column(Boolean, default=False)
    note = Column(String, default="")
    patient = relationship("Patient", back_populates="logs")

class Descriptor(Base):
    """The patient's own words for a concept, e.g. concept='mood', phrase='foggy and flat'."""
    __tablename__ = "descriptors"
    id = Column(Integer, primary_key=True)
    patient_id = Column(Integer, ForeignKey("patients.id"))
    concept = Column(String)
    phrase = Column(String)
    created_at = Column(DateTime, default=dt.datetime.utcnow)
    patient = relationship("Patient", back_populates="descriptors")

class Turn(Base):
    __tablename__ = "turns"
    id = Column(Integer, primary_key=True)
    patient_id = Column(Integer, ForeignKey("patients.id"))
    role = Column(String)        # "user" | "assistant"
    content = Column(String)
    created_at = Column(DateTime, default=dt.datetime.utcnow)
    patient = relationship("Patient", back_populates="turns")

Base.metadata.create_all(engine)

# ---------------------------------------------------------------- app
app = FastAPI(title="Myno backend")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

FEATURES = {  # feature key -> human label + which log fields it governs
    "mood":     {"label": "Mood & mental health", "fields": ["mood"]},
    "diet":     {"label": "Diet & sugar",          "fields": ["sugar", "cravings"]},
    "hair_skin":{"label": "Hair & skin",           "fields": ["hair_growth", "hair_loss"]},
    "weight":   {"label": "Weight & BMI",          "fields": []},
    "fertility":{"label": "Fertility & conception","fields": []},
    "pain":     {"label": "Pain",                  "fields": ["pain"]},
}

@app.get("/healthz")
def healthz():
    return {"status": "ok", "model": ANTHROPIC_MODEL, "features": list(FEATURES.keys())}

# ----- patients
class PatientIn(BaseModel):
    name: str = ""; age: Optional[int] = None; menarche_age: Optional[int] = None
    height_cm: Optional[float] = None; weight_kg: Optional[float] = None
    family_history: bool = False; acne: bool = False; skin_darkening: bool = False
    weight_gain: bool = False; goals: list = []; integrations: list = []

def patient_dict(p: Patient):
    return {c.name: getattr(p, c.name) for c in p.__table__.columns}

@app.post("/patients")
def create_patient(body: PatientIn):
    s = Session()
    p = Patient(**body.dict()); s.add(p); s.commit(); s.refresh(p)
    out = patient_dict(p); s.close(); return out

@app.get("/patients/{pid}")
def get_patient(pid: int):
    s = Session(); p = s.get(Patient, pid)
    if not p: s.close(); raise HTTPException(404, "no such patient")
    out = patient_dict(p); s.close(); return out

@app.patch("/patients/{pid}")
def update_patient(pid: int, body: dict):
    s = Session(); p = s.get(Patient, pid)
    if not p: s.close(); raise HTTPException(404)
    for k, v in body.items():
        if hasattr(p, k): setattr(p, k, v)
    s.commit(); out = patient_dict(p); s.close(); return out

# ----- daily logs
@app.get("/patients/{pid}/logs")
def get_logs(pid: int):
    s = Session()
    rows = s.query(DailyLog).filter_by(patient_id=pid).order_by(DailyLog.date).all()
    out = [{c.name: (v.isoformat() if isinstance(v := getattr(r, c.name), dt.date) else v)
            for c in r.__table__.columns} for r in rows]
    s.close(); return out

@app.post("/patients/{pid}/logs")
def upsert_log(pid: int, body: dict):
    s = Session()
    d = dt.date.fromisoformat(body["date"])
    row = s.query(DailyLog).filter_by(patient_id=pid, date=d).first() or DailyLog(patient_id=pid, date=d)
    for k, v in body.items():
        if k != "date" and hasattr(row, k): setattr(row, k, v)
    s.add(row); s.commit(); s.close(); return {"ok": True}

# ----- blacklist (feature blocking)
@app.get("/patients/{pid}/blacklist")
def get_blacklist(pid: int):
    s = Session(); p = s.get(Patient, pid); bl = p.blacklist or []; s.close()
    return {"blacklist": bl, "features": FEATURES}

@app.put("/patients/{pid}/blacklist")
def put_blacklist(pid: int, body: dict):
    s = Session(); p = s.get(Patient, pid)
    p.blacklist = [f for f in body.get("blacklist", []) if f in FEATURES]
    s.commit(); bl = p.blacklist; s.close(); return {"blacklist": bl}

# ----- personal descriptors
@app.get("/patients/{pid}/descriptors")
def get_descriptors(pid: int):
    s = Session()
    rows = s.query(Descriptor).filter_by(patient_id=pid).order_by(Descriptor.created_at.desc()).all()
    out = [{"concept": r.concept, "phrase": r.phrase} for r in rows]; s.close(); return out

# ---------------------------------------------------------------- chat
async def claude(system: str, messages: list, max_tokens=900) -> str:
    if not ANTHROPIC_API_KEY:
        raise HTTPException(500, "ANTHROPIC_API_KEY not configured")
    headers = {"x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01",
               "content-type": "application/json"}
    payload = {"model": ANTHROPIC_MODEL, "max_tokens": max_tokens, "system": system, "messages": messages}
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post("https://api.anthropic.com/v1/messages", headers=headers, json=payload)
        r.raise_for_status()
        data = r.json()
    return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()

class ChatIn(BaseModel):
    message: str

@app.post("/patients/{pid}/chat")
async def chat(pid: int, body: ChatIn):
    s = Session(); p = s.get(Patient, pid)
    if not p: s.close(); raise HTTPException(404)
    blacklist = p.blacklist or []
    blocked_labels = [FEATURES[f]["label"] for f in blacklist if f in FEATURES]
    descriptors = s.query(Descriptor).filter_by(patient_id=pid).order_by(Descriptor.created_at.desc()).limit(20).all()
    desc_lines = "; ".join(f"{d.concept}: \"{d.phrase}\"" for d in descriptors) or "none yet"
    history = s.query(Turn).filter_by(patient_id=pid).order_by(Turn.created_at).limit(20).all()
    msgs = [{"role": t.role, "content": t.content} for t in history]
    msgs.append({"role": "user", "content": body.message})

    avg_gap = _avg_cycle(s, pid)
    system = f"""You are Myno, a warm voice companion for someone navigating possible or diagnosed PCOS.
You know general PCOS knowledge: the Rotterdam criteria (2 of 3 — irregular ovulation; clinical/biochemical hyperandrogenism; polycystic morphology on ultrasound), that mimics (thyroid, prolactin, CAH, Cushing's) must be excluded, and that PCOS links to insulin resistance, type 2 diabetes, cardiovascular and mood risks.

YOUR JOB EACH TURN:
- Acknowledge what they said in THEIR words, then ask ONE relevant next question to understand their situation.
- Reuse the patient's own vocabulary. Known phrasings -> {desc_lines}.
- ADAPT to them. Current read of this patient: {json.dumps(p.adapt_state or {})}. If they seem distressed, be gentler and shorter. If terse, keep it brief. If they want detail, give it.
- Goals: {p.goals or []}. Avg tracked cycle: {avg_gap} days.

HARD CONSTRAINTS:
- NEVER ask about, request, or volunteer anything in this blocked list: {blocked_labels or 'none'}. If they raise a blocked topic themselves, respond briefly and respectfully without probing, and move on.
- NEVER diagnose or say whether they have PCOS; a clinician decides. Offer to help them prepare.
- No specific drug doses. Spoken aloud, so keep the 'reply' under ~45 words.

Return ONLY JSON, no prose, no code fences:
{{"reply": str,
  "descriptors": [{{"concept": str, "phrase": str}}],   // new personal phrasings the patient used (e.g. how they describe mood/pain). [] if none.
  "adapt": {{"tone": "gentle"|"neutral"|"upbeat", "length": "short"|"medium", "distress": 0-3}}
}}"""

    raw = await claude(system, msgs)
    reply, new_desc, adapt = body.message and "", [], {}
    try:
        a, b = raw.index("{"), raw.rindex("}")
        obj = json.loads(raw[a:b + 1])
        reply = obj.get("reply", ""); new_desc = obj.get("descriptors", []) or []; adapt = obj.get("adapt", {}) or {}
    except Exception:
        reply = raw

    # persist turn + learned personalization + adaptation
    s.add(Turn(patient_id=pid, role="user", content=body.message))
    s.add(Turn(patient_id=pid, role="assistant", content=reply))
    for d in new_desc[:5]:
        if d.get("concept") and d.get("phrase"):
            s.add(Descriptor(patient_id=pid, concept=d["concept"][:40], phrase=d["phrase"][:200]))
    if adapt:
        p.adapt_state = {**(p.adapt_state or {}), **adapt}
    s.commit(); s.close()
    return {"reply": reply, "learned": new_desc, "adapt": adapt}

def _avg_cycle(s, pid):
    rows = s.query(DailyLog).filter_by(patient_id=pid).filter(DailyLog.period == True).order_by(DailyLog.date).all()
    if len(rows) < 2: return None
    gaps = [(rows[i].date - rows[i-1].date).days for i in range(1, len(rows))]
    return round(sum(gaps) / len(gaps))

# ----- TTS proxy (single origin for the browser)
@app.post("/tts")
async def tts(body: dict):
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(f"{TTS_URL}/tts", json={"text": body.get("text", "")})
        r.raise_for_status()
        return Response(content=r.content, media_type="audio/wav")
