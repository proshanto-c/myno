"""
Every endpoint, over the real app, against the real database.

Runs inside the backend container, where FastAPI and its test client live:

    docker compose exec -T backend python test_api.py

It creates its own patient and works only on that, so it can run against a
live database without touching anyone else's rows. Endpoints that call Claude
are exercised for their contract, not their content, and are allowed to fail
when there is no key or no credit — that is a bill, not a bug.
"""
import datetime as dt
import json

from starlette.testclient import TestClient

import main

client = TestClient(main.app)
T = []
test = lambda fn: (T.append((fn.__name__, fn)), fn)[1]
TODAY = dt.date.today()
iso = lambda n: (TODAY - dt.timedelta(days=n)).isoformat()


def new_patient(**fields):
    r = client.post("/patients", json={"name": "test", **fields})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def put_logs(pid, entries):
    for e in entries:
        r = client.post(f"/patients/{pid}/logs", json=e)
        assert r.status_code == 200, r.text


# ---- the schema and the rules ---------------------------------------------
@test
def test_record_schema_shape():
    body = client.get("/record/schema").json()
    keys = [g["key"] for g in body["schema"]]
    assert keys == ["cycle", "wellbeing", "body", "lifestyle", "skin"]
    for group in body["schema"]:
        assert group["group"] and group["fields"]
        for f in group["fields"]:
            assert f["key"] and f["label"] and f["type"]
            if f["type"] == "select":
                assert f["options"], f["key"]
            if f["type"] == "scale":
                assert f["max"] and len(f["words"]) >= 2, f["key"]
            if f.get("showIf"):
                assert "field" in f["showIf"] and "equals" in f["showIf"]

@test
def test_schema_field_keys_are_unique():
    body = client.get("/record/schema").json()
    keys = [f["key"] for g in body["schema"] for f in g["fields"]]
    assert len(keys) == len(set(keys)), keys

@test
def test_criteria_rules_are_served():
    rules = client.get("/criteria/rules").json()
    assert rules["cycleBands"] and rules["singleCycleDays"] == 90

@test
def test_sources_name_where_each_number_came_from():
    body = client.get("/sources").json()
    ids = [s["id"] for s in body["sources"]]
    assert "guideline2023" in ids and "belsey1986" in ids and "ours" in ids
    for src in body["sources"]:
        assert src["name"] and src["used"], src["id"]
    # the guideline's own thresholds must be the ones the rules actually use
    rules = client.get("/criteria/rules").json()
    text = " ".join(u for s in body["sources"] for u in s["used"])
    assert str(rules["singleCycleDays"]) in text
    assert str(rules["amenorrheaAge"]) in text
    assert str(rules["mfgHirsutism"]) in text
    assert str(rules["cycleBands"][-1]["longDays"]) in text

@test
def test_the_extractor_is_told_to_invent_nothing():
    sys_prompt = main._extract_sys([])
    assert "Invent nothing" in sys_prompt
    assert "categories" not in sys_prompt          # no personal tracker to build
    dropped = main._normalize_extract_payload({"categories": [{"key": "tinnitus", "label": "Ringing"}], "pain": 4})
    assert "categories" not in dropped and dropped["pain"] == 4

@test
def test_what_can_be_plotted_is_what_the_form_asks():
    import record
    numeric = [f for f in record.EXTRACTABLE if f["type"] in ("scale", "emoji", "number")]
    assert [f["key"] for f in numeric] == ["mood", "energy", "sleep", "brainFog", "pain",
                                           "morningWeight", "sugar", "foodDrive", "sexDrive"]
    # the live panel on the Record screen drops the one marked for it
    live = [f["key"] for f in numeric if f.get("liveTrend") is not False]
    assert "sexDrive" not in live and len(live) == 8
    assert record.field("sexDrive")["liveTrend"] is False
    assert "sexDrive" in record.extract_shape()

@test
def test_one_pooled_client_serves_every_upstream_call():
    first = main.http()
    assert main.http() is first, "a new client per call means a new TLS handshake per call"
    assert first.is_closed is False

@test
def test_shutdown_closes_the_client_and_every_background_task():
    # a fresh app instance so we can watch its whole lifecycle
    with TestClient(main.app):
        client_during = main.http()
        assert client_during.is_closed is False
    assert client_during.is_closed is True, "the pooled client outlived the app"
    assert not main._tasks, f"background tasks left running: {main._tasks}"

@test
def test_background_work_is_tracked_so_it_can_be_stopped():
    import inspect
    src = inspect.getsource(main)
    # every long-lived task goes through track(); a bare create_task is one
    # nobody can cancel at shutdown
    assert src.count("asyncio.create_task(") == 1, "only track() should create tasks"

@test
def test_healthz():
    body = client.get("/healthz").json()
    assert body["status"] == "ok" and "claude_cache" in body


# ---- patients --------------------------------------------------------------
@test
def test_create_read_and_patch_a_patient():
    pid = new_patient()
    r = client.patch(f"/patients/{pid}", json={
        "age": 28, "menarche_age": 13, "conditions": ["hirsutism"],
        "mfg": {"chin": 3}, "drugs": ["glp1"], "pmos_diagnosed": False, "pmos_diagnosed_on": ""})
    assert r.status_code == 200
    got = client.get(f"/patients/{pid}").json()
    assert got["conditions"] == ["hirsutism"] and got["mfg"] == {"chin": 3}

@test
def test_patching_an_unknown_field_is_ignored_not_fatal():
    pid = new_patient()
    assert client.patch(f"/patients/{pid}", json={"nonsense": 1}).status_code == 200

@test
def test_a_missing_patient_is_a_404():
    assert client.patch("/patients/999999", json={"age": 3}).status_code == 404
    assert client.get("/patients/999999").status_code == 404


# ---- logs ------------------------------------------------------------------
@test
def test_logging_a_day_and_reading_it_back():
    pid = new_patient()
    put_logs(pid, [{"date": iso(0), "period": True, "pain": 6, "dietCarbs": "low"}])
    rows = client.get(f"/patients/{pid}/logs").json()
    assert len(rows) == 1 and rows[0]["pain"] == 6 and rows[0]["dietCarbs"] == "low"

@test
def test_logging_the_same_day_twice_updates_it():
    pid = new_patient()
    put_logs(pid, [{"date": iso(0), "pain": 2}, {"date": iso(0), "pain": 9}])
    rows = client.get(f"/patients/{pid}/logs").json()
    assert len(rows) == 1 and rows[0]["pain"] == 9

@test
def test_a_log_with_only_a_date_is_accepted():
    pid = new_patient()
    put_logs(pid, [{"date": iso(0)}])
    assert len(client.get(f"/patients/{pid}/logs").json()) == 1


# ---- the summary -----------------------------------------------------------
@test
def test_summary_of_an_empty_patient():
    pid = new_patient()
    s = client.get(f"/patients/{pid}/summary").json()
    assert s["loggedDays"] == 0 and s["cycle"] is None and s["cycleDay"] is None
    assert [g["key"] for g in s["byCategory"]] == ["cycle", "wellbeing", "body", "lifestyle", "skin"]

@test
def test_summary_over_three_regular_cycles():
    pid = new_patient()
    put_logs(pid, [{"date": iso(90 - i), "period": i % 30 < 4, "pain": i % 8, "sleep": i % 5}
                   for i in range(91)])
    s = client.get(f"/patients/{pid}/summary").json()
    assert s["loggedDays"] == 91
    assert s["cycle"]["meanDays"] == 30
    assert s["cycleDay"] == 1                      # the run restarted today
    assert s["cycle"]["label"] in ("Regular", "Irregular", "Not assessable")

@test
def test_summary_ignores_days_logged_in_the_future():
    pid = new_patient()
    put_logs(pid, [{"date": (TODAY + dt.timedelta(days=5)).isoformat(), "period": True},
                   {"date": iso(3), "period": True}])
    s = client.get(f"/patients/{pid}/summary").json()
    assert s["cycleDay"] == 4                      # counted from the past start


# ---- the assessment --------------------------------------------------------
@test
def test_assessment_of_an_empty_patient():
    pid = new_patient()
    a = client.get(f"/patients/{pid}/assessment").json()
    assert a["cycles"]["state"] == "unknown"
    assert a["recommendation"]["key"] in ("unknown", "soon")

@test
def test_assessment_reads_conditions_and_the_mfg_sheet():
    pid = new_patient()
    client.patch(f"/patients/{pid}", json={"age": 28, "menarche_age": 13,
                                           "conditions": ["hypothyroidism"], "mfg": {"chin": 4}})
    a = client.get(f"/patients/{pid}/assessment").json()
    assert a["inputs"]["mfgScore"] == 4
    assert a["androgen"]["state"] == "met"
    assert any("Hypothyroidism" in c for c in a["context"])

@test
def test_a_diagnosis_changes_the_verdict():
    pid = new_patient()
    client.patch(f"/patients/{pid}", json={"pmos_diagnosed": True, "pmos_diagnosed_on": "2021-03-12"})
    a = client.get(f"/patients/{pid}/assessment").json()
    assert a["diagnosed"] is True and a["recommendation"]["key"] == "diagnosed"

@test
def test_the_pill_under_drug_therapy_blocks_the_cycle_criterion():
    pid = new_patient()
    client.patch(f"/patients/{pid}", json={"age": 28, "menarche_age": 13, "drugs": ["ocp"]})
    put_logs(pid, [{"date": iso(60 - i), "period": i % 30 < 4} for i in range(61)])
    a = client.get(f"/patients/{pid}/assessment").json()
    assert a["cycles"]["state"] == "unknown"
    assert "contraception" in a["cycles"]["reasons"][0]

@test
def test_assess_accepts_hypothetical_inputs():
    r = client.post("/assess", json={"inputs": {"age": 28, "hasMenarche": True, "cyclesObserved": 4,
                                                "minCycle": 26, "maxCycle": 50}, "rules": {}})
    assert r.status_code == 200 and r.json()["cycles"]["state"] == "met"

@test
def test_assess_survives_a_hostile_body():
    for body in ({}, {"inputs": {}}, {"inputs": None, "rules": None},
                 {"inputs": {"age": "old"}, "rules": {"cycleBands": None}},
                 {"inputs": {"maxCycle": 10 ** 9}, "rules": {"singleCycleDays": "x"}}):
        r = client.post("/assess", json=body)
        # a malformed body earns a 422, never a 500 — and anything it does
        # accept has to come back as a complete verdict
        assert r.status_code in (200, 422), (body, r.text)
        if r.status_code == 200:
            assert r.json()["recommendation"]["key"], body


# ---- seeding and suggestions ----------------------------------------------
@test
def test_seeding_is_idempotent():
    pid = new_patient()
    first = client.post(f"/patients/{pid}/seed").json()
    second = client.post(f"/patients/{pid}/seed").json()
    assert first["seeded"] is True and second["seeded"] is False

@test
def test_seeded_logs_never_run_past_today():
    pid = new_patient()
    client.post(f"/patients/{pid}/seed")
    rows = client.get(f"/patients/{pid}/logs").json()
    assert max(r["date"] for r in rows) <= TODAY.isoformat()

@test
def test_suggestions_endpoint_answers_even_before_it_has_any():
    pid = new_patient()
    body = client.get(f"/patients/{pid}/suggestions").json()
    assert "suggestions" in body


# ---- the model-backed endpoints: contract only ----------------------------
@test
def test_insights_endpoint_returns_stats_even_if_the_model_fails():
    pid = new_patient()
    put_logs(pid, [{"date": iso(40 - i), "period": i % 30 < 4, "pain": i % 8} for i in range(41)])
    r = client.post(f"/patients/{pid}/insights")
    if r.status_code == 200:
        body = r.json()
        assert body["stats"]["loggedDays"] == 41
        assert [c["key"] for c in body["categories"]][0] == "cycle"
        for item in body["analysis"]["insights"]:
            assert item["category"] in {"cycle", "wellbeing", "body", "lifestyle", "skin"}
    else:
        assert r.status_code == 502, r.text          # a Claude failure, surfaced

@test
def test_spoken_places_become_markers_on_the_drawing():
    import record
    pts = record.pain_points(["lower abdomen", "my lower back"])
    assert [p["label"] for p in pts] == ["lower abdomen", "lower back"]
    assert pts[0]["view"] == "front" and pts[1]["view"] == "back"
    for p in pts:
        assert 0 < p["x"] < 1 and 0 < p["y"] < 1
    # unknown places are dropped, and the same place twice is one marker
    assert record.pain_points(["the moon"]) == []
    assert len(record.pain_points(["chest", "chest"])) == 1
    assert record.pain_points(None) == []

@test
def test_the_extractor_is_told_which_places_it_may_name():
    import record
    shape = record.extract_shape()
    assert '"painAreas"' in shape
    for name in ("lower abdomen", "lower back", "chest"):
        assert name in shape, name

@test
def test_pain_areas_are_converted_before_they_reach_the_client():
    out = main._normalize_extract_payload({"painAreas": ["pelvis"], "pain": 12})
    assert "painAreas" not in out
    assert out["painPoints"][0]["label"] == "pelvis"
    assert out["pain"] == 10          # clamped

@test
def test_extract_prompt_lists_every_schema_field():
    import record
    shape = record.extract_shape()
    for f in record.EXTRACTABLE:
        assert f'"{f["key"]}"' in shape, f["key"]


if __name__ == "__main__":
    passed = failed = 0
    for name, fn in T:
        try:
            fn(); passed += 1
        except AssertionError as e:
            failed += 1; print(f"FAIL {name}: {e}")
        except Exception as e:
            failed += 1; print(f"ERROR {name}: {type(e).__name__}: {e}")
    print(f"{passed} passed, {failed} failed")
    raise SystemExit(1 if failed else 0)
