"""
Exercises the insight rules directly: no server, no database, no network.

Run:  python -m pytest backend/test_insights.py -q
      python backend/test_insights.py          (no pytest needed)
"""
import datetime as dt

import insights as ins

DAY0 = dt.date(2026, 1, 1)


def days(n, **cols):
    """n consecutive logged days; each column is a list or a constant."""
    out = []
    for i in range(n):
        log = {"date": (DAY0 + dt.timedelta(days=i)).isoformat()}
        for k, v in cols.items():
            log[k] = v[i] if isinstance(v, list) else v
        out.append(log)
    return out


# ---- cycles ----------------------------------------------------------------
def test_a_multi_day_bleed_is_one_cycle_start():
    logs = days(40, period=[i < 5 or 28 <= i < 32 for i in range(40)])
    assert ins.cycle_starts(logs) == ["2026-01-01", "2026-01-29"]
    assert ins.cycle_gaps(logs) == [28]
    assert ins.average_cycle_days(logs) == 28

def test_runs_of_period_days_never_become_one_day_cycles():
    # the bug this guards: counting every bleeding day as a cycle start gives
    # gaps of 1 day and an "average cycle" of 1
    logs = days(10, period=True)
    assert ins.cycle_gaps(logs) == []
    assert ins.average_cycle_days(logs) is None

def test_gaps_shorter_than_the_floor_are_dropped():
    logs = days(30, period=[i in (0, 5, 20) for i in range(30)])
    assert ins.cycle_gaps(logs) == [15]      # the 5-day gap is the same bleed

def test_cycle_stats_need_two_gaps():
    one = ins.summarise(days(40, period=[i == 0 or i == 28 for i in range(40)]))
    assert one["cycle"] is None and one["cycleCount"] == 1
    two = ins.summarise(days(70, period=[i in (0, 28, 56) for i in range(70)]))
    assert two["cycle"]["cycles"] == 3 and two["cycle"]["meanDays"] == 28

def test_cycle_day_counts_from_the_last_start():
    logs = days(35, period=[i in (0, 28) for i in range(35)])
    # the bleed began on index 28; on index 34 you are on cycle day 7
    assert ins.summarise(logs, today=DAY0 + dt.timedelta(days=34))["cycleDay"] == 7
    # the first day of bleeding is day 1, not day 0
    assert ins.summarise(logs, today=DAY0 + dt.timedelta(days=28))["cycleDay"] == 1

def test_cycle_day_is_measured_from_today_not_the_last_log():
    logs = days(35, period=[i in (0, 28) for i in range(35)])
    # stopped logging on index 34, but a week has passed since
    assert ins.summarise(logs, today=DAY0 + dt.timedelta(days=41))["cycleDay"] == 14

def test_a_start_dated_in_the_future_is_not_the_current_cycle():
    logs = days(40, period=[i in (0, 28, 38) for i in range(40)])
    assert ins.summarise(logs, today=DAY0 + dt.timedelta(days=30))["cycleDay"] == 3


# ---- correlations ----------------------------------------------------------
def test_correlation_needs_enough_paired_days():
    rising = list(range(7))
    assert ins.pearson(list(zip(rising, rising))) is None        # 7 pairs
    assert ins.pearson(list(zip(range(8), range(8))))["r"] == 1.0

def test_a_flat_column_has_no_correlation():
    assert ins.pearson([(5, i) for i in range(20)]) is None

def test_weak_correlations_are_not_reported():
    logs = days(30, sleep=[i % 7 for i in range(30)], energy=[(i * 3) % 5 for i in range(30)])
    labels = [c["label"] for c in ins.summarise(logs)["correlations"]]
    assert "Less sleep → lower energy" not in labels

def test_a_label_that_reads_backwards_is_marked_as_reversed():
    # "Less sleep -> more brain fog" is confirmed by a NEGATIVE r; here sleep and
    # fog rise together, so the claim does not hold even though |r| is high
    logs = days(30, sleep=[i % 10 for i in range(30)], brainFog=[i % 10 for i in range(30)])
    hit = next(c for c in ins.summarise(logs)["correlations"] if c["label"] == "Less sleep → more brain fog")
    assert hit["r"] == 1.0 and hit["holds"] is False

def test_every_correlation_declares_which_sign_confirms_it():
    assert all(c.get("expect") in ("+", "-") for c in ins.CORRELATIONS)

def test_a_real_correlation_is_reported_with_its_strength():
    logs = days(30, sleep=[i % 10 for i in range(30)], energy=[i % 10 for i in range(30)])
    hit = next(c for c in ins.summarise(logs)["correlations"] if c["label"] == "Less sleep → lower energy")
    assert hit["r"] == 1.0 and hit["strength"] == "very strong" and hit["direction"] == "positive"
    assert hit["holds"] is True

def test_strength_wording_tracks_the_bands():
    assert (ins.strength(0.85), ins.strength(0.65), ins.strength(0.45),
            ins.strength(0.25), ins.strength(0.1)) == (
        "very strong", "strong", "moderate", "weak", "negligible")

def test_lagged_pairs_look_at_the_day_before():
    # sugar spikes on day 0 only; pain spikes on day 1 only
    logs = days(12, sugar=[9 if i == 0 else 0 for i in range(12)],
                pain=[9 if i == 1 else 0 for i in range(12)])
    assert ins.pearson(ins._pairs(logs, "lagged", "sugar", "pain"))["r"] == 1.0
    assert ins.pearson(ins._pairs(logs, "same", "sugar", "pain"))["r"] < 0


# ---- trends ----------------------------------------------------------------
def test_trend_needs_enough_points():
    assert ins.slope_per_week([1, 2, 3, 4, 5, 6, 7]) is None
    assert ins.slope_per_week([1, 2, 3, 4, 5, 6, 7, 8]) == 7.0   # +1/day = +7/week

def test_flat_and_tiny_drifts_are_not_trends():
    flat = ins.summarise(days(30, pain=5))
    assert [t for t in flat["trends"] if t["key"] == "pain"] == []

def test_a_rising_metric_is_reported_as_up():
    logs = days(30, pain=[i / 10 for i in range(30)])
    trend = next(t for t in ins.summarise(logs)["trends"] if t["key"] == "pain")
    assert trend["direction"] == "up" and trend["perWeek"] == 0.7


# ---- day-level aggregates --------------------------------------------------
def test_high_sugar_split_uses_the_named_threshold():
    logs = days(11, sugar=[9 if i % 2 == 0 else 0 for i in range(11)],
                pain=[8 if i % 2 == 1 else 2 for i in range(11)])
    s = ins.summarise(logs)
    assert s["painAfterHighSugar"] == 8 and s["painAfterLowSugar"] == 2

def test_raising_the_high_sugar_bar_moves_days_across():
    logs = days(11, sugar=5, pain=4)
    assert ins.summarise(logs)["painAfterHighSugar"] == 4          # 5 >= 3
    strict = {**ins.RULES, "highSugar": 8}
    assert ins.summarise(logs, rules=strict)["painAfterHighSugar"] is None

def test_days_since_severe_pain():
    assert ins.summarise(days(10, pain=[9] + [1] * 9))["daysSinceSeverePain"] == 9
    assert ins.summarise(days(10, pain=[1] * 9 + [9]))["daysSinceSeverePain"] == 0
    assert ins.summarise(days(10, pain=1))["daysSinceSeverePain"] == 10

def test_flag_percentages():
    s = ins.summarise(days(10, hairGrowth=[i < 3 for i in range(10)]))
    assert s["hairGrowthDaysPct"] == 30.0 and s["hairLossDaysPct"] == 0.0


# ---- self-named trackers ---------------------------------------------------
def test_a_tracker_needs_a_few_readings():
    def cat(n):
        return [{"date": (DAY0 + dt.timedelta(days=i)).isoformat(),
                 "categories": [{"key": "fog", "label": "Brain fog", "scale": {"value": i, "max": 10}}]}
                for i in range(n)]
    assert ins.summarise(cat(2))["categoryTrends"] == []
    got = ins.summarise(cat(6))["categoryTrends"][0]
    assert got["key"] == "fog" and got["n"] == 6 and got["earlier"] < got["recent"]


# ---- categories mirror the Record screen -----------------------------------
def test_categories_come_from_the_record_schema():
    import record
    assert ins.CATEGORIES == record.CATEGORIES
    assert [k for k, _ in ins.CATEGORIES] == ["cycle", "wellbeing", "body", "lifestyle", "skin"]

def test_every_correlation_is_filed_under_a_real_section():
    known = {k for k, _ in ins.CATEGORIES}
    for c in ins.CORRELATIONS:
        assert c.get("category", ins.category_of(c["b"])) in known, c["label"]
    for _, _, cat in ins.TRENDED:
        assert cat in known

def test_a_finding_lands_in_its_own_section():
    logs = days(30, sleep=[i % 10 for i in range(30)], energy=[i % 10 for i in range(30)])
    groups = {g["key"]: g for g in ins.summarise(logs)["byCategory"]}
    assert "Less sleep → lower energy" in [c["label"] for c in groups["wellbeing"]["correlations"]]
    assert groups["skin"]["correlations"] == []

def test_all_sections_are_listed_even_when_empty():
    groups = ins.summarise([])["byCategory"]
    assert [g["key"] for g in groups] == [k for k, _ in ins.CATEGORIES]
    assert all(g["count"] == 0 and g["facts"] == [] for g in groups)


# ---- the cycle label belongs to criteria.py --------------------------------
def test_cycle_label_is_blank_until_the_verdict_is_passed_in():
    logs = days(70, period=[i in (0, 28, 56) for i in range(70)])
    assert ins.summarise(logs)["cycle"]["regular"] is None
    labelled = ins.summarise(logs, cycle_verdict={"state": "met", "reasons": ["because"]})
    assert labelled["cycle"]["label"] == "Irregular" and labelled["cycle"]["regular"] is False

def test_empty_logs_do_not_explode():
    s = ins.summarise([])
    assert s["loggedDays"] == 0 and s["cycle"] is None and s["correlations"] == []


# ---- edges -----------------------------------------------------------------
def test_a_single_logged_day_summarises_without_error():
    s = ins.summarise(days(1, pain=5, period=True))
    assert s["loggedDays"] == 1 and s["cycle"] is None
    assert s["correlations"] == [] and s["trends"] == []

def test_logs_with_nothing_but_dates():
    s = ins.summarise([{"date": "2026-01-01"}, {"date": "2026-01-02"}])
    assert s["avgPain"] is None and s["byCategory"][0]["facts"] == []

def test_every_day_a_period_day_is_one_run():
    s = ins.summarise(days(60, period=True))
    assert s["periodsLogged"] == 1 and s["cycleCount"] == 0 and s["cycle"] is None

def test_alternate_day_bleeding_is_not_a_string_of_cycles():
    logs = days(60, period=[i % 2 == 0 for i in range(60)])
    assert ins.cycle_gaps(logs) == []          # every gap is 2 days, under the floor

def test_out_of_order_logs_are_read_in_order():
    logs = list(reversed(days(70, period=[i in (0, 28, 56) for i in range(70)])))
    assert ins.cycle_starts(logs) == ["2026-01-01", "2026-01-29", "2026-02-26"]

def test_extreme_values_do_not_break_the_statistics():
    logs = days(20, pain=[0, 10] * 10, sugar=[10, 0] * 10, sleep=1e6, mood=-50)
    s = ins.summarise(logs)
    assert isinstance(s["avgPain"], float)
    for c in s["correlations"]:
        assert -1.0 <= c["r"] <= 1.0

def test_a_flat_metric_has_no_trend_and_no_correlation():
    s = ins.summarise(days(40, pain=5, sugar=5, mood=5))
    assert [t for t in s["trends"] if t["key"] in ("pain", "sugar", "mood")] == []
    assert s["correlations"] == []

def test_string_values_where_numbers_belong_are_ignored():
    logs = days(20, pain=["ouch"] * 20, sugar=3)
    s = ins.summarise(logs)
    assert s["avgPain"] is None and s["daysSinceSeverePain"] == 20

def test_a_category_without_a_scale_is_not_trended():
    logs = [{"date": f"2026-01-{i+1:02d}", "categories": [{"key": "k", "label": "K", "value": "words"}]}
            for i in range(10)]
    assert ins.summarise(logs)["categoryTrends"] == []

def test_every_category_key_in_the_summary_is_a_real_section():
    known = {k for k, _ in ins.CATEGORIES}
    s = ins.summarise(days(40, pain=[i % 9 for i in range(40)], period=[i in (0, 30) for i in range(40)]))
    assert {g["key"] for g in s["byCategory"]} == known

def test_thresholds_can_be_pushed_to_their_limits():
    logs = days(30, sugar=[i % 5 for i in range(30)], pain=[i % 5 for i in range(30)])
    for rules in ({**ins.RULES, "minAbsR": 0}, {**ins.RULES, "minAbsR": 1.1},
                  {**ins.RULES, "minPairsForCorrelation": 1}, {**ins.RULES, "minPointsForTrend": 1000}):
        s = ins.summarise(logs, rules=rules)
        assert isinstance(s["correlations"], list) and isinstance(s["trends"], list)

def test_cycle_day_with_no_starts_at_all():
    assert ins.cycle_day([]) is None
    assert ins.summarise(days(10))["cycleDay"] is None


if __name__ == "__main__":
    passed = failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn(); passed += 1
            except AssertionError as e:
                failed += 1; print(f"FAIL {name}: {e or ''}")
    print(f"{passed} passed, {failed} failed")
    raise SystemExit(1 if failed else 0)
