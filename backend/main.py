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
import os, json, random, math, statistics, asyncio, urllib.parse, datetime as dt
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
    suggestions = Column(JSON, default=list)        # research-backed tracker suggestions (daily)
    suggestions_at = Column(DateTime, nullable=True)
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
    data = Column(JSON, default=dict)     # full daily-log JSON (all schema fields + categories)
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
# lightweight migration: add the JSON column to pre-existing tables
with engine.begin() as _conn:
    _conn.execute(text("ALTER TABLE daily_logs ADD COLUMN IF NOT EXISTS data JSON DEFAULT '{}'::json"))
    _conn.execute(text("ALTER TABLE patients ADD COLUMN IF NOT EXISTS suggestions JSON DEFAULT '[]'::json"))
    _conn.execute(text("ALTER TABLE patients ADD COLUMN IF NOT EXISTS suggestions_at TIMESTAMP"))

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

# ----- daily logs (the full daily-log JSON lives in DailyLog.data; a few
# analytics columns are mirrored for querying / legacy rows)
def _log_dict(r: "DailyLog"):
    base = {"date": r.date.isoformat(), "period": r.period, "pain": r.pain, "sugar": r.sugar,
            "mood": r.mood, "energy": r.energy, "hairGrowth": r.hair_growth, "hairLoss": r.hair_loss,
            "bloating": r.bloating, "cravings": r.cravings, "note": r.note or ""}
    base.update(r.data or {})
    base["date"] = r.date.isoformat()
    return base

@app.get("/patients/{pid}/logs")
def get_logs(pid: int):
    s = Session()
    rows = s.query(DailyLog).filter_by(patient_id=pid).order_by(DailyLog.date).all()
    out = [_log_dict(r) for r in rows]
    s.close(); return out

@app.post("/patients/{pid}/logs")
def upsert_log(pid: int, body: dict):
    s = Session()
    d = dt.date.fromisoformat(body["date"])
    row = s.query(DailyLog).filter_by(patient_id=pid, date=d).first() or DailyLog(patient_id=pid, date=d)
    row.data = {k: v for k, v in body.items() if k != "date"}
    row.period = body.get("period"); row.pain = body.get("pain"); row.sugar = body.get("sugar")
    row.mood = body.get("mood"); row.energy = body.get("energy")
    row.hair_growth = bool(body.get("hairGrowth")); row.hair_loss = bool(body.get("hairLoss"))
    row.bloating = bool(body.get("bloating")); row.cravings = bool(body.get("cravings"))
    row.note = body.get("note", "")
    s.add(row); s.commit(); s.close(); return {"ok": True}

# ----- realistic prepopulation (idempotent) so the Insights tab has real trends
def _seed_categories(premen, brain_fog, pain):
    cats = []
    if brain_fog >= 3:
        cats.append({"key": "brain_fog", "label": "Brain fog", "value": "heavy" if brain_fog >= 4 else "foggy", "scale": {"value": min(10, brain_fog * 2 + 1), "max": 10}})
    if premen and pain >= 6:
        cats.append({"key": "headache", "label": "Headache", "value": "throbbing", "scale": {"value": min(10, pain), "max": 10}})
    return cats

def _seed_logs(pid: int, days: int = 120):
    s = Session()
    today = dt.date.today()
    weight = round(random.uniform(72, 78), 1)
    since = 6
    cycle = random.randint(31, 44)        # PCOS: long / irregular cycles
    prev_sugar = 1
    for i in range(days, -1, -1):
        d = today - dt.timedelta(days=i)
        is_start = since == 0
        premen = since > cycle - 4
        sugar = random.randint(0, 4)
        pain = 1 + random.randint(0, 1) + round(prev_sugar * 0.8)   # high sugar -> next-day pain
        if is_start or since == 1: pain += 4
        if premen: pain += 1
        pain = max(0, min(10, pain))
        sleep = max(0, min(4, 3 - (1 if premen else 0) + random.randint(-1, 1)))
        brain_fog = max(0, min(4, (4 - sleep) - 1 + (1 if premen else 0) + random.randint(-1, 1)))
        mood = max(0, min(4, 3 - (2 if premen else 0) - (1 if pain > 6 else 0) + random.randint(-1, 1)))
        energy = max(0, min(4, sleep - (1 if pain > 6 else 0) + random.randint(-1, 1)))
        ovulation = cycle // 2 - 2 < since < cycle // 2 + 2
        sex_drive = max(0, min(4, 2 + (1 if ovulation else 0) - (1 if premen else 0) + random.randint(-1, 1)))
        food_drive = max(0, min(4, sugar + (1 if premen else 0) + random.randint(-1, 1)))
        weight = round(weight + random.uniform(-0.25, 0.28), 1)
        cravings = prev_sugar > 2 or premen or random.random() < 0.2
        acne = (premen and random.random() < 0.7) or random.random() < 0.12
        bloating = pain > 5 or random.random() < 0.2
        data = {
            "period": is_start, "flow": (random.choice(["heavy", "medium"]) if is_start else None),
            "birthControl": "none",
            "pain": pain, "mood": mood, "energy": energy, "sleep": sleep, "brainFog": brain_fog,
            "sexDrive": sex_drive, "sugar": sugar, "foodDrive": food_drive, "dietExercise": "",
            "painMap": ("lower abdomen" if (is_start or since == 1) else ""),
            "morningWeight": weight,
            "hairGrowth": random.random() < 0.25, "hairLoss": random.random() < 0.12,
            "acne": acne, "skinPatches": random.random() < 0.05, "hyperpigmentation": random.random() < 0.06,
            "bloating": bloating, "cravings": cravings, "diagnoses": "",
            "categories": _seed_categories(premen, brain_fog, pain), "note": "",
        }
        s.add(DailyLog(patient_id=pid, date=d, period=is_start, pain=pain, sugar=sugar, mood=mood,
                       energy=energy, hair_growth=data["hairGrowth"], hair_loss=data["hairLoss"],
                       bloating=bloating, cravings=cravings, note="", data=data))
        prev_sugar = sugar
        since += 1
        if since >= cycle:
            since = 0; cycle = random.randint(31, 44)
    s.commit(); s.close()

@app.post("/patients/{pid}/seed")
def seed(pid: int):
    s = Session(); n = s.query(DailyLog).filter_by(patient_id=pid).count(); s.close()
    if n == 0:
        _seed_logs(pid); return {"seeded": True}
    return {"seeded": False, "count": n}

# ----- insights: compute trends/correlations over the DB logs, then have Claude
# narrate concrete, data-grounded insights for the Insights tab.
def _mean(a):
    a = [x for x in a if isinstance(x, (int, float))]
    return round(sum(a) / len(a), 2) if a else None

def _pearson(pairs):
    """Pearson r (point-biserial when one var is a 0/1 flag). None if too few pairs."""
    pairs = [(x, y) for x, y in pairs if isinstance(x, (int, float)) and isinstance(y, (int, float))]
    n = len(pairs)
    if n < 8:
        return None
    mx = sum(x for x, _ in pairs) / n
    my = sum(y for _, y in pairs) / n
    cov = sum((x - mx) * (y - my) for x, y in pairs)
    vx = sum((x - mx) ** 2 for x, _ in pairs)
    vy = sum((y - my) ** 2 for _, y in pairs)
    if vx <= 0 or vy <= 0:
        return None
    return {"r": round(cov / math.sqrt(vx * vy), 2), "n": n}

def _strength(r):
    a = abs(r)
    return ("very strong" if a >= 0.8 else "strong" if a >= 0.6 else
            "moderate" if a >= 0.4 else "weak" if a >= 0.2 else "negligible")

def _slope_per_week(ys):
    """Least-squares slope over the index (days), expressed as units per week."""
    pts = [(i, y) for i, y in enumerate(ys) if isinstance(y, (int, float))]
    n = len(pts)
    if n < 8:
        return None
    mx = sum(i for i, _ in pts) / n
    my = sum(y for _, y in pts) / n
    den = sum((i - mx) ** 2 for i, _ in pts)
    if den <= 0:
        return None
    return round(sum((i - mx) * (y - my) for i, y in pts) / den * 7, 2)

def _insight_summary(logs):
    def col(k): return [l.get(k) for l in logs if isinstance(l.get(k), (int, float))]
    hi, lo = [], []
    for i in range(1, len(logs)):
        ps, pn = logs[i - 1].get("sugar"), logs[i].get("pain")
        if isinstance(ps, (int, float)) and isinstance(pn, (int, float)):
            (hi if ps >= 3 else lo).append(pn)
    bloat = [l.get("pain") for l in logs if l.get("bloating")]
    nobloat = [l.get("pain") for l in logs if not l.get("bloating")]
    starts = [l["date"] for l in logs if l.get("period")]
    gaps = [(dt.date.fromisoformat(starts[i]) - dt.date.fromisoformat(starts[i - 1])).days for i in range(1, len(starts))]
    gaps = [g for g in gaps if g > 10]
    cat_trend = {}
    for l in logs:
        for c in (l.get("categories") or []):
            if c.get("scale"):
                cat_trend.setdefault(c["key"], {"label": c.get("label", c["key"]), "vals": []})["vals"].append(c["scale"]["value"])
    cats = []
    for k, v in cat_trend.items():
        vals = v["vals"]
        if len(vals) >= 3:
            h = len(vals) // 2
            pw = _slope_per_week(vals)
            cats.append({"key": k, "label": v["label"], "avg": _mean(vals), "earlier": _mean(vals[:h]),
                         "recent": _mean(vals[h:]), "n": len(vals), "perWeek": pw})

    # --- Pearson correlations (point-biserial for binary flags), ranked by |r| ---
    def lag(a, b): return [(logs[i - 1].get(a), logs[i].get(b)) for i in range(1, len(logs))]
    def same(a, b): return [(logs[i].get(a), logs[i].get(b)) for i in range(len(logs))]
    def flagp(flag, b): return [(1 if logs[i].get(flag) else 0, logs[i].get(b)) for i in range(len(logs))]
    candidates = [
        ("Higher sugar → next-day pain", lag("sugar", "pain")),
        ("Less sleep → more brain fog", same("sleep", "brainFog")),
        ("Less sleep → lower energy", same("sleep", "energy")),
        ("Higher pain → lower mood", same("pain", "mood")),
        ("Bloating days → higher pain", flagp("bloating", "pain")),
        ("Higher sugar → next-day cravings", [(logs[i - 1].get("sugar"), 1 if logs[i].get("cravings") else 0) for i in range(1, len(logs))]),
    ]
    corrs = []
    for label, pairs in candidates:
        p = _pearson(pairs)
        if p and abs(p["r"]) >= 0.2:
            corrs.append({"label": label, "r": p["r"], "n": p["n"], "strength": _strength(p["r"]),
                          "direction": "positive" if p["r"] > 0 else "negative"})
    corrs.sort(key=lambda c: -abs(c["r"]))

    # --- cycle variability (mean ± SD, coefficient of variation) ---
    cycle = None
    if len(gaps) >= 2:
        m = statistics.mean(gaps); sd = statistics.pstdev(gaps)
        reg = (21 <= m <= 35 and sd <= 4)
        cycle = {"meanDays": round(m, 1), "sdDays": round(sd, 1), "cv": round(sd / m * 100, 1) if m else None,
                 "min": min(gaps), "max": max(gaps), "cycles": len(gaps) + 1, "regular": reg,
                 "label": ("Regular" if reg else ("Long / irregular" if m > 35 else "Variable"))}

    # --- linear trends (units/week) for the standard metrics ---
    trends = []
    for k, lbl in [("pain", "Pain"), ("mood", "Mood"), ("energy", "Energy"), ("sleep", "Sleep"), ("brainFog", "Brain fog")]:
        pw = _slope_per_week([l.get(k) for l in logs])
        if pw is not None and abs(pw) >= 0.05:
            trends.append({"key": k, "label": lbl, "perWeek": pw, "direction": "up" if pw > 0 else "down"})

    return {
        "loggedDays": len(logs),
        "avgPain": _mean(col("pain")), "avgMood": _mean(col("mood")), "avgEnergy": _mean(col("energy")),
        "avgSleep": _mean(col("sleep")), "avgBrainFog": _mean(col("brainFog")), "avgSugar": _mean(col("sugar")),
        "painAfterHighSugar": _mean(hi), "painAfterLowSugar": _mean(lo),
        "painWithBloating": _mean(bloat), "painWithoutBloating": _mean(nobloat),
        "avgCycleDays": _mean(gaps), "cycleMin": (min(gaps) if gaps else None), "cycleMax": (max(gaps) if gaps else None),
        "correlations": corrs, "cycle": cycle, "trends": trends,
        "categoryTrends": cats,
        "recent": {k: [l.get(k) for l in logs[-30:]] for k in ["pain", "mood", "energy", "sleep", "brainFog"]},
    }

@app.post("/patients/{pid}/insights")
async def patient_insights(pid: int):
    s = Session()
    rows = s.query(DailyLog).filter_by(patient_id=pid).order_by(DailyLog.date).all()
    p = s.get(Patient, pid); blocked = (p.blacklist or []) if p else []
    logs = [_log_dict(r) for r in rows]; s.close()
    stats = _insight_summary(logs)
    block_line = ", ".join(FEATURES[f]["label"] for f in blocked if f in FEATURES) or "none"
    sys = (
        "You are Myno, a practical PCOS companion. From this person's own tracking summary, produce 2-4 "
        "concrete, data-grounded insights — each a real trend or correlation in THEIR numbers — with brief, "
        "actionable, non-diagnostic advice. Never diagnose or give drug doses. "
        f"NEVER reference anything blocked: {block_line}.\n"
        'Return ONLY JSON: {"summary":str (<=40 words overview), '
        '"insights":[{"title":str (<=8 words),"detail":str (<=35 words),"strength":0-100}]}.'
    )
    raw = await claude(sys, [{"role": "user", "content": json.dumps(stats)}], max_tokens=700)
    try:
        a, b = raw.index("{"), raw.rindex("}"); analysis = json.loads(raw[a:b + 1])
    except Exception:
        analysis = {"summary": "", "insights": []}
    return {"stats": stats, "analysis": analysis}

# ----- research-backed "what else to track" suggestions (regenerated daily in
# the background over each patient's data; surfaced dynamically in the UI)
STANDARD_TRACKERS = [
    "menstrual period start", "cycle length", "flow intensity", "birth control", "mood", "energy",
    "sleep quality", "brain fog", "sex drive", "pelvic / cramp pain", "pain location", "morning body weight",
    "cravings", "food / appetite drive", "diet & exercise", "acne / breakouts", "excess hair growth",
    "hair loss", "skin patches", "hyperpigmentation", "bloating", "existing diagnoses",
]
SUGG_SYSTEM = (
    "You are a PCOS research analyst reviewing recent literature (2022-2025). The purpose is to generate "
    "possible items for the user to track in another part of the app.\n"
    "The user will tell you what their app already tracks, and optionally what devices they own.\n"
    "Return ONLY a JSON array, no markdown, no preamble. Each item:\n"
    '{"tracker":"short name (2-5 words)","explanation":"1-2 sentences for a general audience (no jargon) on why '
    'this is worth tracking for PCOS - focus on what the person might notice or why it matters for how they feel",'
    '"category":"one of: Symptom | Metabolic | Hormonal | Gut | Sleep | Skin | Neurological | Reproductive",'
    '"evidence":"Strong | Emerging | Early","tracking_method":"how the tracking app can get this information.",'
    '"requires_device":true or false,"device_needed":"name of device if requires_device is true, else null",'
    '"pubmed_query":"a precise 4-8 word PubMed search query to find the key supporting paper"}\n'
    "Rules:\n- Only suggest things NOT already tracked by the app\n"
    "- If requires_device is true AND the user does not own that device, still include it (the caller deprioritises it)\n"
    "- Order: self-report items first, device-dependent items last\n- 6-10 suggestions total"
)
SUGG_TTL = dt.timedelta(hours=20)

def _pubmed_link(q: str) -> str:
    return f"https://pubmed.ncbi.nlm.nih.gov/?term={urllib.parse.quote(q or 'PCOS')}&sort=date"

async def _gap_suggestions(current_trackers, devices, focus):
    trackers_str = "\n".join(f"- {t}" for t in current_trackers)
    devices_str = "\n".join(f"- {d}" for d in devices) if devices else "none specified"
    focus_line = f"\nFocus area: {focus}" if focus else ""
    prompt = f"Current app trackers:\n{trackers_str}\n\nUser's devices:\n{devices_str}{focus_line}"
    raw = await claude(SUGG_SYSTEM, [{"role": "user", "content": prompt}], max_tokens=2000)
    try:
        a, b = raw.index("["), raw.rindex("]"); items = json.loads(raw[a:b + 1])
    except Exception:
        return []
    dev_lower = [d.lower() for d in (devices or [])]
    out = []
    for s in items:
        if not isinstance(s, dict) or not s.get("tracker"):
            continue
        rd = bool(s.get("requires_device"))
        dn = s.get("device_needed") or ""
        owned = (not rd) or any(dn.lower() in d for d in dev_lower)
        out.append({
            "tracker": s.get("tracker", ""), "explanation": s.get("explanation", ""),
            "category": s.get("category", ""), "evidence": s.get("evidence", ""),
            "tracking_method": s.get("tracking_method", ""), "requires_device": rd,
            "device_needed": s.get("device_needed"), "device_owned": owned,
            "read_more": _pubmed_link(s.get("pubmed_query", "PCOS")),
        })
    out.sort(key=lambda x: (x["requires_device"], not x["device_owned"]))
    return out

_sugg_inflight = set()

async def _refresh_suggestions(pid: int, force: bool = False):
    if pid in _sugg_inflight:
        return
    s = Session(); p = s.get(Patient, pid)
    if not p:
        s.close(); return
    fresh = p.suggestions and p.suggestions_at and (dt.datetime.utcnow() - p.suggestions_at) < SUGG_TTL
    if fresh and not force:
        s.close(); return
    rows = s.query(DailyLog).filter_by(patient_id=pid).order_by(DailyLog.date.desc()).limit(60).all()
    cats = {}
    for r in rows:
        for c in ((r.data or {}).get("categories") or []):
            if c.get("label"):
                cats[c["key"]] = c["label"]
    devices = p.integrations or []
    s.close()
    _sugg_inflight.add(pid)
    try:
        current = STANDARD_TRACKERS + list(cats.values())
        sugg = await _gap_suggestions(current, devices, "insulin resistance")
        if sugg:
            s2 = Session(); p2 = s2.get(Patient, pid)
            if p2:
                p2.suggestions = sugg; p2.suggestions_at = dt.datetime.utcnow(); s2.commit()
            s2.close()
    except Exception:
        pass
    finally:
        _sugg_inflight.discard(pid)

async def _suggestions_daily_loop():
    await asyncio.sleep(30)  # let startup settle; GET handles the first on-demand fill
    while True:
        try:
            s = Session(); ids = [p.id for p in s.query(Patient).all()]; s.close()
            for pid in ids:
                await _refresh_suggestions(pid)
        except Exception:
            pass
        await asyncio.sleep(24 * 3600)

@app.on_event("startup")
async def _startup():
    asyncio.create_task(_suggestions_daily_loop())

# ----- advocacy report ("GP visit prep"): match a curated advocacy bank against
# the patient's DB-derived metrics, then have Claude personalize the framing.
ADVOCACY_BANK = [
    {"id": "pain_severe_frequent", "category": "pain", "trigger_conditions": {"type": "threshold", "metric": "pain_severe_days_per_cycle", "operator": ">=", "value": 3},
     "clinical_framing": "I have severe pain on {pain_severe_days_per_cycle} days during most cycles, mainly around days 1-3, and it interferes with work and daily activities.",
     "keywords_phrases": ["This level of pain is affecting my quality of life.", "I'd like this pain documented in my notes.", "I'd like to discuss pain management options beyond over-the-counter medication."],
     "questions_to_ask": ["Given this pain pattern, could we explore whether further investigation (e.g. an ultrasound) is appropriate?", "What pain management options are suitable given my other PCOS symptoms?"]},
    {"id": "cycle_irregularity", "category": "cycle_regularity", "trigger_conditions": {"type": "threshold", "metric": "cycle_length_std_dev", "operator": ">=", "value": 7},
     "clinical_framing": "My cycle length has varied by roughly {cycle_length_std_dev} days over the last {period_days} days, ranging from {cycle_length_min} to {cycle_length_max} days.",
     "keywords_phrases": ["I'd like this irregularity recorded as part of my history.", "This pattern has been consistent over several months, not a one-off."],
     "questions_to_ask": ["Given this irregularity, would it be appropriate to check hormone levels (e.g. LH, FSH, testosterone) or have an ultrasound?", "Could this pattern be related to PCOS, and if so, what would the next step be?"]},
    {"id": "missed_periods", "category": "cycle_regularity", "trigger_conditions": {"type": "threshold", "metric": "missed_periods_last_6mo", "operator": ">=", "value": 2},
     "clinical_framing": "I've missed {missed_periods_last_6mo} periods in the last 6 months.",
     "keywords_phrases": ["I'd like this gap recorded in my notes.", "I'd like to understand what's causing this before it continues."],
     "questions_to_ask": ["Should we investigate this with bloodwork or imaging?", "Is this consistent with PCOS, or could it indicate something else worth ruling out?"]},
    {"id": "fatigue_persistent", "category": "fatigue_energy", "trigger_conditions": {"type": "threshold", "metric": "fatigue_days_per_week", "operator": ">=", "value": 4},
     "clinical_framing": "I experience significant fatigue on {fatigue_days_per_week} days most weeks, even with adequate sleep.",
     "keywords_phrases": ["This fatigue isn't explained by my sleep or lifestyle.", "I'd like to rule out other causes, such as thyroid issues or anaemia.", "I'd like this logged so we can track whether it changes."],
     "questions_to_ask": ["Could we test thyroid function and iron/ferritin levels given this fatigue pattern?", "Could this fatigue be linked to insulin resistance, given my PCOS?"]},
    {"id": "mood_low_frequent", "category": "mood", "trigger_conditions": {"type": "threshold", "metric": "mood_low_days_per_month", "operator": ">=", "value": 10},
     "clinical_framing": "I've logged low mood on {mood_low_days_per_month} days in the last month, and it feels connected to my cycle and hormone patterns.",
     "keywords_phrases": ["I'd like this considered as part of my hormonal health picture, not just on its own.", "I'm not only asking for a general mental health referral - I think this may be connected to my PCOS."],
     "questions_to_ask": ["Could there be a hormonal contribution to this mood pattern that's worth addressing alongside any mental health support?"]},
    {"id": "hirsutism", "category": "hair_skin", "trigger_conditions": {"type": "boolean", "metric": "hirsutism_descriptor_present", "value": True},
     "clinical_framing": "I've noticed increased hair growth in a male-pattern distribution (e.g. {hirsutism_areas}), which has developed or changed over {hirsutism_duration}.",
     "keywords_phrases": ["I'd like this assessed as a possible sign of androgen excess.", "I'd like this documented alongside my other symptoms."],
     "questions_to_ask": ["Could we test androgen levels (e.g. free testosterone, DHEAS) given this symptom?", "If this is androgen-related, what treatment options are available?"]},
    {"id": "acne_persistent", "category": "hair_skin", "trigger_conditions": {"type": "threshold", "metric": "acne_flare_frequency_per_month", "operator": ">=", "value": 2},
     "clinical_framing": "I've had acne flare-ups {acne_flare_frequency_per_month} times in the last month, mostly along my jawline and chin - a pattern often linked to hormone levels.",
     "keywords_phrases": ["I'd like this considered alongside my other symptoms, not just as a skin issue.", "Topical treatments alone haven't addressed this."],
     "questions_to_ask": ["Could this acne pattern be related to my hormone levels, and is that worth investigating?"]},
    {"id": "weight_change_unexplained", "category": "weight", "trigger_conditions": {"type": "threshold_abs", "metric": "weight_change_kg_3mo", "operator": ">=", "value": 3},
     "clinical_framing": "I've had a change of roughly {weight_change_kg_3mo}kg over the last 3 months without a corresponding change in my diet or activity.",
     "keywords_phrases": ["I'd like this change documented.", "I'm not looking for general weight advice - I'd like to understand why this is happening given my other symptoms."],
     "questions_to_ask": ["Could this weight change be related to insulin resistance or another hormonal factor?", "Is it worth checking blood sugar or insulin levels given this pattern?"]},
    {"id": "insulin_resistance_pattern", "category": "metabolic", "trigger_conditions": {"type": "boolean", "metric": "insulin_resistance_symptoms_present", "value": True},
     "clinical_framing": "I've noticed a pattern of {insulin_resistance_symptom_description}, which can be associated with insulin resistance in PCOS.",
     "keywords_phrases": ["I'd like to rule out insulin resistance given this pattern and my PCOS symptoms.", "I'd like this tested rather than just managed with general dietary advice."],
     "questions_to_ask": ["Could we do a fasting glucose/insulin test or HbA1c given these symptoms?", "If insulin resistance is confirmed, what management options would be appropriate?"]},
    {"id": "sleep_disturbance", "category": "sleep", "trigger_conditions": {"type": "threshold", "metric": "sleep_disturbance_nights_per_week", "operator": ">=", "value": 3},
     "clinical_framing": "I have disrupted sleep on {sleep_disturbance_nights_per_week} nights most weeks, and it doesn't seem to correlate with stress or lifestyle changes.",
     "keywords_phrases": ["I'd like this connected to my other symptoms when reviewing my hormone health.", "This has been ongoing for several months."],
     "questions_to_ask": ["Could this sleep pattern be related to my hormone levels or PCOS?"]},
    {"id": "fertility_concern", "category": "fertility", "trigger_conditions": {"type": "boolean", "metric": "fertility_concern_flag", "value": True},
     "clinical_framing": "I have concerns about my fertility given my cycle pattern and PCOS, and I'd like to discuss this proactively rather than waiting until I'm trying to conceive.",
     "keywords_phrases": ["I'd like to understand my options now, even though I'm not trying to conceive yet.", "I'd like a referral to discuss this if that's appropriate."],
     "questions_to_ask": ["What does my cycle pattern suggest about my fertility, and is there anything worth addressing now?", "Would a referral to a gynaecologist or fertility specialist be appropriate given my history?"]},
    {"id": "documentation_request_general", "category": "general", "trigger_conditions": {"type": "always"},
     "clinical_framing": "Regardless of what we decide today, I'd like to make sure these symptoms and this data are recorded in my notes.",
     "keywords_phrases": ["Could this be added to my chart, even if no action is taken today?", "I'd like a record of this conversation for future appointments."],
     "questions_to_ask": []},
    {"id": "pcos_diagnosis_review", "category": "general", "trigger_conditions": {"type": "composite", "metric": "no_formal_pcos_diagnosis", "value": True, "min_matched_categories": 2},
     "clinical_framing": "I haven't had a formal diagnosis confirming or ruling out PCOS, but I'm experiencing several symptoms commonly associated with it ({matched_categories}).",
     "keywords_phrases": ["I'd like to work towards a clearer picture - even a working diagnosis would help me know what to track and discuss going forward.", "I'd like this combination of symptoms considered together rather than individually."],
     "questions_to_ask": ["Given these symptoms together, does pursuing a PCOS diagnosis (e.g. via the Rotterdam criteria) seem appropriate?", "What would the next steps be to confirm or rule this out?"]},
]
ADVOCACY_BL_MAP = {"hair_skin": "hair_skin", "mood": "mood", "weight": "weight", "pain": "pain", "fertility": "fertility", "diet": "metabolic"}

def _cmp(v, op, t):
    return {">=": v >= t, "<=": v <= t, ">": v > t, "<": v < t, "==": v == t}.get(op, False)

def _eval_trigger(trig, ins):
    tt = trig["type"]
    if tt == "always":
        return True
    if tt in ("threshold", "threshold_abs"):
        v = ins.get(trig["metric"])
        if v is None:
            return False
        return _cmp(abs(v) if tt == "threshold_abs" else v, trig["operator"], trig["value"])
    if tt == "boolean":
        return ins.get(trig["metric"]) == trig["value"]
    return None  # composite handled later

def _match_bank(ins, blocked):
    avail = [e for e in ADVOCACY_BANK if e["category"] not in blocked]
    simple, composite = [], []
    for e in avail:
        if e["trigger_conditions"]["type"] == "composite":
            composite.append(e)
        elif _eval_trigger(e["trigger_conditions"], ins):
            simple.append(e)
    matched_cats = {e["category"] for e in simple}
    for e in composite:
        t = e["trigger_conditions"]
        if ins.get(t["metric"]) == t["value"] and len(matched_cats) >= t["min_matched_categories"]:
            e = dict(e); e["_matched_categories"] = sorted(matched_cats); simple.append(e)
    return simple

def _advocacy_metrics(logs, patient):
    days = max(1, len(logs))
    def avg(k):
        xs = [l[k] for l in logs if isinstance(l.get(k), (int, float))]
        return sum(xs) / len(xs) if xs else None
    def cnt(pred):
        return sum(1 for l in logs if pred(l))
    starts = [l["date"] for l in logs if l.get("period")]
    gaps = [(dt.date.fromisoformat(starts[i]) - dt.date.fromisoformat(starts[i - 1])).days for i in range(1, len(starts))]
    gaps = [g for g in gaps if g > 10]
    cycles = max(1, len(gaps))
    wlogs = [l for l in logs if isinstance(l.get("morningWeight"), (int, float))]
    sugar_avg = avg("sugar") or 0
    cravings_rate = cnt(lambda l: l.get("cravings")) / days
    ir = cravings_rate > 0.35 and sugar_avg >= 2.5
    diag = ""
    for l in reversed(logs):
        if l.get("diagnoses"):
            diag = str(l["diagnoses"]); break
    goals = (patient.goals or []) if patient else []
    return {
        "period_days": days,
        "cycle_length_avg": round(statistics.mean(gaps), 1) if gaps else None,
        "cycle_length_std_dev": round(statistics.pstdev(gaps), 1) if len(gaps) >= 2 else 0,
        "cycle_length_min": min(gaps) if gaps else None,
        "cycle_length_max": max(gaps) if gaps else None,
        "missed_periods_last_6mo": sum(1 for g in gaps if g > 45),
        "pain_severe_days_per_cycle": round(cnt(lambda l: isinstance(l.get("pain"), (int, float)) and l["pain"] >= 7) / cycles, 1),
        "fatigue_days_per_week": round(cnt(lambda l: isinstance(l.get("energy"), (int, float)) and l["energy"] <= 1) / days * 7, 1),
        "mood_low_days_per_month": round(cnt(lambda l: isinstance(l.get("mood"), (int, float)) and l["mood"] <= 1) / days * 30, 1),
        "energy_avg_score": round((avg("energy") or 0) * 2.5, 1),
        "hirsutism_descriptor_present": (cnt(lambda l: l.get("hairGrowth")) / days) > 0.15,
        "hirsutism_areas": "the areas you've noted", "hirsutism_duration": "recent months",
        "acne_flare_frequency_per_month": round(cnt(lambda l: l.get("acne")) / days * 30, 1),
        "weight_change_kg_3mo": round(wlogs[-1]["morningWeight"] - wlogs[0]["morningWeight"], 1) if len(wlogs) >= 2 else 0,
        "insulin_resistance_symptoms_present": ir,
        "insulin_resistance_symptom_description": "frequent sugar cravings and afternoon energy dips" if ir else None,
        "sleep_disturbance_nights_per_week": round(cnt(lambda l: isinstance(l.get("sleep"), (int, float)) and l["sleep"] <= 1) / days * 7, 1),
        "fertility_concern_flag": any("concei" in str(g).lower() or "fertil" in str(g).lower() for g in goals),
        "prior_dismissal_flag": False,
        "no_formal_pcos_diagnosis": "pcos" not in diag.lower(),
    }

ADVOCACY_SYSTEM = (
    "You are generating a GP visit preparation report for a patient with PCOS or a related endocrine condition.\n"
    "You will be given the patient's logged-data insights, their stored descriptors (their own words), a list of "
    "advocacy bank entries whose trigger_conditions matched, their blacklist, and their adapt_state.\n"
    "Your task:\n1. Write a brief, factual trends summary using the patient's own descriptor language where it fits.\n"
    "2. From the matched entries, select the most relevant (prioritise strongest triggers / most impact in a short "
    "appointment). You need not use all.\n3. Personalize each clinical_framing by filling {placeholders} with the "
    "patient's actual numbers from the insights.\n4. Do NOT alter keywords_phrases or questions_to_ask - copy them "
    "verbatim.\n5. Introduce no new medical claims, diagnoses, tests, or terminology beyond the matched entries.\n"
    "6. Never reference a blacklisted category.\n7. Match tone/length to adapt_state; keep talking_points concise "
    "and scannable.\n"
    "Respond with ONLY a JSON object (no markdown, no preamble): "
    '{"trends_summary":"...","flagged_patterns":["..."],"talking_points":[{"category":"...","clinical_framing":"...",'
    '"keywords_phrases":["..."],"questions_to_ask":["..."]}],"documentation_request_text":"..."}'
)

@app.post("/patients/{pid}/advocacy")
async def advocacy(pid: int):
    s = Session(); p = s.get(Patient, pid)
    if not p:
        s.close(); raise HTTPException(404)
    rows = s.query(DailyLog).filter_by(patient_id=pid).order_by(DailyLog.date).all()
    logs = [_log_dict(r) for r in rows]
    descriptors = [{"concept": d.concept, "phrase": d.phrase} for d in s.query(Descriptor).filter_by(patient_id=pid).all()]
    blacklist = p.blacklist or []; adapt = p.adapt_state or {}
    metrics = _advocacy_metrics(logs, p)
    s.close()
    blocked = {ADVOCACY_BL_MAP.get(b, b) for b in blacklist}
    matched = _match_bank(metrics, blocked)
    payload = {"period_days": metrics["period_days"], "insights": metrics, "descriptors": descriptors,
               "blacklist": blacklist, "adapt_state": adapt, "matched_advocacy_entries": matched}
    raw = await claude(ADVOCACY_SYSTEM, [{"role": "user", "content": json.dumps(payload)}], max_tokens=2000)
    try:
        a, b = raw.index("{"), raw.rindex("}"); report = json.loads(raw[a:b + 1])
    except Exception:
        report = {"trends_summary": "", "flagged_patterns": [], "talking_points": [], "documentation_request_text": ""}
    return {"report": report, "matched": [e["id"] for e in matched], "metrics": metrics}

@app.get("/patients/{pid}/suggestions")
async def get_suggestions(pid: int):
    s = Session(); p = s.get(Patient, pid)
    if not p:
        s.close(); raise HTTPException(404)
    sugg = p.suggestions or []; at = p.suggestions_at; s.close()
    stale = (at is None) or (dt.datetime.utcnow() - at > SUGG_TTL)
    if not sugg or stale:
        asyncio.create_task(_refresh_suggestions(pid))
        return {"suggestions": sugg, "refreshing": True}
    return {"suggestions": sugg, "refreshing": False, "generatedAt": at.isoformat()}

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

# ----- chatbox-mode: a text-first daily check-in that gathers patient-specific
# detail (pulling the patient's descriptors, conversation history, adaptation
# state and tracked cycle from the DB) and then infers the day's tracking
# markers. This powers the Chat tab.
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

# ----- voice → structured daily-log fields + a spoken reply (server-side model;
# no key in the browser). Myno talks back: acknowledges, and asks ONE clarifying
# question when something important is ambiguous, so the patient can just answer.
# Selectable conversation personalities — only the TONE of Myno's spoken reply
# changes; the structural rules (infer ratings, no numbers, brevity) are fixed.
PERSONALITIES = {
    "direct": "Be brief and matter-of-fact — note what you heard in a few words and move on; skip heavy empathy, reassurance, and exclamations.",
    "warm": "Be gentle and empathetic — acknowledge how they feel in a caring, reassuring way, then move on.",
    "coach": "Be encouraging and action-oriented — affirm their effort and nudge one small positive step.",
    "clinical": "Be precise and neutral, like a calm clinician — factual and concise, with no emotional language.",
    "friend": "Be casual and conversational, like a supportive friend — relaxed, relatable, a little informal.",
}

def _style(personality: str) -> str:
    return PERSONALITIES.get(personality or "direct", PERSONALITIES["direct"])

class ExtractIn(BaseModel):
    text: str
    context: str = ""
    blocked: list[str] = []
    categories: list[dict] = []
    personality: str = "direct"

_SCALE_10_FIELDS = {"pain", "mood", "energy", "sleep", "brainFog", "sexDrive", "sugar", "foodDrive"}

def _clamp_10(value):
    try:
        return max(0, min(10, round(float(value))))
    except Exception:
        return None

def _normalize_category_scale(scale):
    if not isinstance(scale, dict) or scale.get("value") is None:
        return None
    try:
        old_max = float(scale.get("max") or 10)
    except Exception:
        old_max = 10
    value = _clamp_10((float(scale["value"]) / old_max) * 10 if old_max > 0 and old_max != 10 else scale["value"])
    if value is None:
        return None
    return {**scale, "value": value, "max": 10}

def _normalize_extract_payload(payload):
    if not isinstance(payload, dict):
        return {}
    out = dict(payload)
    for key in _SCALE_10_FIELDS:
        if key in out and out[key] is not None:
            out[key] = _clamp_10(out[key])
    if isinstance(out.get("categories"), list):
        cats = []
        for cat in out["categories"][:6]:
            if not isinstance(cat, dict):
                continue
            clean = dict(cat)
            scale = _normalize_category_scale(clean.get("scale"))
            if scale:
                clean["scale"] = scale
            else:
                clean.pop("scale", None)
            cats.append(clean)
        out["categories"] = cats
    return out

def _extract_sys(blocked: list[str], personality: str = "direct") -> str:
    block_line = ", ".join(blocked) if blocked else "none"
    return (
        "You are Myno, a warm voice companion helping someone log their PCOS day just by talking. "
        "From the WHOLE conversation so far and what they just said, do three things: reply out loud, "
        "maintain a personalized tracker, and update the standard analytics fields.\n"
        f"- 'say' TONE: {_style(personality)} INFER any ratings/severities yourself — never ask for numbers, scores, or 1-to-10 ratings. Ask a short clarifying question only when genuinely needed (never about numbers), otherwise just acknowledge. Spoken aloud — under ~28 words. Never diagnose.\n"
        "- 'categories': a SMALL evolving set (max 6) of the things THIS person actually talks about, in THEIR words "
        "(e.g. {\"key\":\"brain_fog\",\"label\":\"Brain fog\",\"value\":\"heavy this morning\"}). Reuse the same key when updating an existing one; add a new category when they raise something new; drop nothing unless clearly resolved. "
        "'value' is a short human phrase in their language. Build on the categories provided; keep keys stable (lower_snake_case).\n"
        "- When a category is naturally a rating, severity, intensity, amount, or frequency, ALSO include "
        "\"scale\":{\"value\":int,\"max\":10}: infer the current value as an integer from 0 to 10. "
        "Omit 'scale' for purely qualitative categories. IMPORTANT: a category may already carry a user-set scale value — KEEP that value unless they clearly state a new one in speech.\n"
        f"- NEVER create a category for, ask about, or volunteer anything in this blocked list: {block_line}.\n"
        "- Also fill any standard tracking fields ONLY when clearly implied by what they said; otherwise use null/false. Never force a value.\n"
        "Return ONLY JSON, no prose, no code fences: "
        '{"period":true|false|null,"flow":"none"|"spotting"|"light"|"medium"|"heavy"|null,"birthControl":str|null,'
        '"pain":0-10|null,"mood":0-10|null,"energy":0-10|null,"sleep":0-10|null,"brainFog":0-10|null,"sexDrive":0-10|null,'
        '"sugar":0-10|null,"foodDrive":0-10|null,"dietExercise":str|null,"painMap":str|null,"morningWeight":number|null,'
        '"hairGrowth":bool,"hairLoss":bool,"acne":bool,"skinPatches":bool,"hyperpigmentation":bool,"bloating":bool,"cravings":bool,'
        '"diagnoses":str|null,'
        '"categories":[{"key":str,"label":str,"value":str,"scale":{"value":int,"max":10}}],"say":str}. '
        "Use null/false for fields not mentioned; omit 'scale' where it doesn't fit."
    )

@app.post("/extract")
async def extract(body: ExtractIn):
    ctx = (body.context or "").strip()
    cats = json.dumps(body.categories or [])
    user = (
        (f"Conversation so far: {ctx}\n" if ctx else "")
        + f"Current personalized categories: {cats}\n\n"
        + f'They just said: "{body.text}"'
    )
    raw = await claude(_extract_sys(body.blocked or [], body.personality), [{"role": "user", "content": user}], max_tokens=500)
    try:
        a, b = raw.index("{"), raw.rindex("}")
        return _normalize_extract_payload(json.loads(raw[a:b + 1]))
    except Exception:
        return {}

# ----- live insights: combine tracked history with the current conversation
class AdviseIn(BaseModel):
    note: str = ""
    categories: list[dict] = []
    summary: dict = {}
    blocked: list[str] = []
    personality: str = "direct"

@app.post("/advise")
async def advise(body: AdviseIn):
    block_line = ", ".join(body.blocked) if body.blocked else "none"
    sys = (
        "You are Myno, a practical PCOS companion. Combine the person's tracked history (history_summary) with what "
        "they are telling you right now to surface ONE clear, useful insight: a trend or correlation grounded in THEIR data, "
        "plus brief, actionable, non-diagnostic advice. Never diagnose or give drug doses; a clinician decides. "
        f"NEVER reference anything in this blocked list: {block_line}.\n"
        f"Advice TONE: {_style(body.personality)}\n"
        'Return ONLY JSON, no prose: {"headline":str (<=8 words naming the trend/insight), '
        '"correlations":[{"label":str,"strength":0-100}] (0-3, from their data), '
        '"say":str (<=35 words of practical advice)}. Be concise.'
    )
    user = json.dumps({"today_conversation": body.note, "categories": body.categories, "history_summary": body.summary})
    raw = await claude(sys, [{"role": "user", "content": user}], max_tokens=320)
    try:
        a, b = raw.index("{"), raw.rindex("}")
        return json.loads(raw[a:b + 1])
    except Exception:
        return {}

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
