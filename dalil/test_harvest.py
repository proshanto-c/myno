"""
The harvester, tested without NCBI and without leaving anything behind.

Run:  docker compose exec -T dalil python test_harvest.py

Every test runs inside one transaction that is rolled back at the end, so this
can be pointed at the real database without adding a row to it. The fake client
serves XML rather than parsed records on purpose — the parser stays in the loop,
so a change to either side that breaks the other shows up here.
"""
import datetime as dt

from sqlalchemy.orm import sessionmaker

import harvest
import ncbi
from models import (Citation, Claim, Published, Query, Reviewer, Run, Source,
                    engine, init_db)

T = []
test = lambda fn: (T.append((fn.__name__, fn)), fn)[1]


# ---- a PubMed that lives in this file ---------------------------------------
def article(pmid, title="Sleep quality in polycystic ovary syndrome", pmcid="", doi="",
            year=2020, pub_types=("Journal Article",), mesh=("Polycystic Ovary Syndrome", "Humans"),
            abstract="Women with PCOS reported worse sleep.", retracted=False, refs=()):
    ids = [f'<ArticleId IdType="pubmed">{pmid}</ArticleId>']
    if pmcid:
        ids.append(f'<ArticleId IdType="pmc">{pmcid}</ArticleId>')
    if doi:
        ids.append(f'<ArticleId IdType="doi">{doi}</ArticleId>')
    types = list(pub_types) + (["Retracted Publication"] if retracted else [])
    reference = "".join(
        f'<Reference><Citation>Ref {r}</Citation><ArticleIdList>'
        f'<ArticleId IdType="pubmed">{r}</ArticleId></ArticleIdList></Reference>' for r in refs)
    return f"""<PubmedArticle>
 <MedlineCitation><PMID Version="1">{pmid}</PMID>
  <Article><Journal><ISOAbbreviation>J Test</ISOAbbreviation>
    <JournalIssue><PubDate><Year>{year}</Year></PubDate></JournalIssue></Journal>
   <ArticleTitle>{title}</ArticleTitle>
   {'<Abstract><AbstractText>' + abstract + '</AbstractText></Abstract>' if abstract else ''}
   <PublicationTypeList>{''.join(f'<PublicationType>{t}</PublicationType>' for t in types)}</PublicationTypeList>
  </Article>
  <MeshHeadingList>{''.join(f'<MeshHeading><DescriptorName>{m}</DescriptorName></MeshHeading>' for m in mesh)}</MeshHeadingList>
 </MedlineCitation>
 <PubmedData><ArticleIdList>{''.join(ids)}</ArticleIdList>
  {'<ReferenceList>' + reference + '</ReferenceList>' if reference else ''}</PubmedData>
</PubmedArticle>"""


def wrap(parts):
    return ("<?xml version='1.0'?><PubmedArticleSet>" + "".join(parts) +
            "</PubmedArticleSet>").encode()


class FakeNcbi:
    """Serves a fixed corpus, and can be told to misbehave in the ways the real
    one does: a history that expired, a window that returns fewer records than
    asked for, an identifier that is not in the Open Access subset."""

    def __init__(self, records, count=None):
        self.records = list(records)              # [(pmid, xml)]
        self.count = count if count is not None else len(records)
        self.calls = {"esearch": 0, "efetch_history": 0, "efetch_ids": 0, "oa": 0, "bioc": 0}
        self.expire_history_once = False
        self.drop_from_window = 0                 # simulate deleted citations
        self.oa_records = {}
        self.fulltext = {}
        self.webenv = "W1"

    def esearch(self, term, **kw):
        self.calls["esearch"] += 1
        self.webenv = f"W{self.calls['esearch']}"
        return ncbi.Search(webenv=self.webenv, query_key="1", count=self.count)

    def efetch_history(self, search, retstart, retmax=ncbi.BATCH, db="pubmed"):
        self.calls["efetch_history"] += 1
        if self.expire_history_once:
            self.expire_history_once = False
            raise ncbi.NcbiError("WebEnv expired")
        window = self.records[retstart:retstart + retmax]
        if self.drop_from_window:
            window = window[:-self.drop_from_window]
        return wrap(xml for _, xml in window)

    def efetch_ids(self, ids, db="pubmed"):
        self.calls["efetch_ids"] += 1
        by_pmid = dict(self.records)
        return wrap(by_pmid[i] for i in ids if i in by_pmid)

    def oa(self, pmcid):
        self.calls["oa"] += 1
        return self.oa_records.get(ncbi.norm_pmcid(pmcid))

    def bioc(self, pmcid):
        self.calls["bioc"] += 1
        return self.fulltext[ncbi.norm_pmcid(pmcid)]


# ---- the transaction everything runs in -------------------------------------
# One outer transaction rolled back at the end keeps the real database clean,
# and one savepoint per test keeps the tests clean of each other. Both are
# needed: a `session.rollback()` after a `session.commit()` undoes nothing, so
# without the savepoint one test's rows are still there for the next.
init_db()
connection = engine.connect()
outer = connection.begin()
_Scoped = sessionmaker(bind=connection, join_transaction_mode="create_savepoint")
_open = []


def Scoped():
    s = _Scoped()
    _open.append(s)
    return s


def fresh_query(s, term="test-term"):
    q = Query(name=f"test-{dt.datetime.utcnow().timestamp()}", term=term, informs=["sleep"])
    s.add(q)
    s.commit()
    return q


# ---- one row per paper -------------------------------------------------------
@test
def test_the_same_paper_twice_is_one_row():
    s = Scoped()
    rec = ncbi.parse_records(wrap([article("90000001")]))[0]
    row, created = harvest.upsert(s, rec)
    assert created is True
    again, created_again = harvest.upsert(s, rec)
    assert created_again is False
    assert again.id == row.id
    s.rollback()


@test
def test_a_paper_is_recognised_by_any_of_its_identifiers():
    s = Scoped()
    first = ncbi.parse_records(wrap([article("90000010", pmcid="PMC9000010",
                                             doi="10.1/A")]))[0]
    row, _ = harvest.upsert(s, first)

    for xml in (article("90000010"),                                   # by pmid
                article("", pmcid="PMC9000010").replace('<PMID Version="1"></PMID>', ""),
                article("90000011", doi="10.1/a")):                    # by doi, different case
        rec = ncbi.parse_records(wrap([xml]))[0]
        hit = harvest._matches(s, rec)
        assert hit and hit[0].id == row.id, f"missed the match on {rec.identity!r}"
    s.rollback()


@test
def test_two_rows_are_merged_once_a_record_links_them():
    s = Scoped()
    a, _ = harvest.upsert(s, ncbi.parse_records(wrap([article("90000020")]))[0])
    b, _ = harvest.upsert(s, ncbi.parse_records(wrap([article("90000021", doi="10.1/dup")]))[0])
    assert a.id != b.id
    s.commit()

    # a later record carries both identifiers, so they were one paper all along
    joined = ncbi.parse_records(wrap([article("90000020", doi="10.1/dup")]))[0]
    kept, _ = harvest.upsert(s, joined)
    s.commit()
    assert kept.id == a.id, "the older row should be the survivor"
    assert b.merged_into == a.id
    assert b.pmid is None and b.doi is None, "a merged row must give up its identifiers"
    assert kept.doi == "10.1/dup", "the surviving row did not take the id over"
    s.rollback()


@test
def test_merging_carries_the_citations_and_claims_across():
    s = Scoped()
    a, _ = harvest.upsert(s, ncbi.parse_records(wrap([article("90000030")]))[0])
    b, _ = harvest.upsert(s, ncbi.parse_records(
        wrap([article("90000031", doi="10.1/carry", refs=["90000099"])]))[0])
    s.add(Claim(source_id=b.id, claim_text="a claim on the row about to be dropped"))
    s.commit()

    harvest.upsert(s, ncbi.parse_records(wrap([article("90000030", doi="10.1/carry")]))[0])
    s.commit()
    assert s.query(Citation).filter(Citation.source_id == a.id).count() == 1
    assert s.query(Claim).filter(Claim.source_id == a.id).count() == 1
    assert s.query(Claim).filter(Claim.source_id == b.id).count() == 0
    s.rollback()


@test
def test_an_unchanged_record_is_not_rewritten():
    s = Scoped()
    rec = ncbi.parse_records(wrap([article("90000040")]))[0]
    row, _ = harvest.upsert(s, rec)
    row.screen_state = "included"
    s.commit()

    harvest.upsert(s, rec)
    s.commit()
    assert row.screen_state == "included", "a re-fetch undid a reviewer's decision"
    s.rollback()


@test
def test_a_second_identifier_is_added_but_a_conflicting_one_is_not():
    s = Scoped()
    row, _ = harvest.upsert(s, ncbi.parse_records(wrap([article("90000050")]))[0])
    harvest.upsert(s, ncbi.parse_records(wrap([article("90000050", pmcid="PMC9000050")]))[0])
    assert row.pmcid == "PMC9000050"
    # a row that already has a PMCID and meets a different one is two papers
    harvest.upsert(s, ncbi.parse_records(wrap([article("90000050", pmcid="PMC9999999")]))[0])
    assert row.pmcid == "PMC9000050"
    s.rollback()


# ---- what a machine may exclude ---------------------------------------------
@test
def test_the_automatic_screen_only_excludes_the_obvious():
    make = lambda **kw: ncbi.parse_records(wrap([article("90000060", **kw)]))[0]
    assert harvest.auto_screen(make()) == ("new", "")
    assert harvest.auto_screen(make(retracted=True))[0] == "excluded"
    assert harvest.auto_screen(make(mesh=("Animals",)))[0] == "excluded"
    assert harvest.auto_screen(make(mesh=("Animals", "Humans")))[0] == "new", \
        "a study in both is still a study in humans"


@test
def test_a_guideline_with_no_abstract_is_not_thrown_away():
    """PMID 30257632 — the 2018 international guideline, and the ancestor of the
    thresholds criteria.py cites — arrives with an empty abstract and a single
    publication type of "Journal Article". An earlier screen excluded it."""
    s = Scoped()
    rec = ncbi.parse_records(wrap([article(
        "90011000", title="A new evidence-based guideline for assessment and management "
                          "of polycystic ovary syndrome", abstract="")]))[0]
    assert harvest.auto_screen(rec) == ("new", "")
    row, _ = harvest.upsert(s, rec)

    # after enrichment there is still nothing to read, but that is not a verdict
    fake = FakeNcbi([])
    harvest.enrich(s, fake, row)
    assert row.screen_state == "needs_text", row.screen_state
    assert "abstract" in row.screen_reason
    s.rollback()


@test
def test_a_source_with_text_is_left_for_a_person_to_screen():
    s = Scoped()
    row, _ = harvest.upsert(s, ncbi.parse_records(wrap([article("90011010")]))[0])
    harvest.enrich(s, FakeNcbi([]), row)
    assert row.screen_state == "new", "an abstract is text enough to appraise"
    s.rollback()


# ---- runs, cursors and resumption -------------------------------------------
@test
def test_a_run_walks_the_whole_result_a_batch_at_a_time():
    s = Scoped()
    fake = FakeNcbi([(str(90001000 + i), article(str(90001000 + i))) for i in range(25)])
    run = harvest.harvest(s, fake, fresh_query(s), batch=10)
    assert run.state == "done"
    assert run.cursor == 25
    assert run.fetched == 25
    assert run.added == 25
    assert fake.calls["efetch_history"] == 3
    s.rollback()


@test
def test_a_restart_resumes_at_the_cursor_and_repeats_nothing():
    s = Scoped()
    records = [(str(90002000 + i), article(str(90002000 + i))) for i in range(30)]
    fake = FakeNcbi(records)
    run = harvest.start(s, fake, fresh_query(s))
    harvest.advance(s, fake, run, batches=1, batch=10)
    assert run.cursor == 10
    s.commit()

    # the process dies here; another one picks the run up from the database
    other = Scoped()
    same = other.get(Run, run.id)
    assert same.cursor == 10, "the cursor was not committed"
    while same.state == "running":
        harvest.advance(other, fake, same, batches=1, batch=10)
    other.commit()
    assert same.fetched == 30
    assert same.added == 30, "resuming re-added records it had already stored"
    assert other.query(Source).filter(Source.pmid.like("90002%")).count() == 30
    other.rollback()
    s.rollback()


@test
def test_a_window_with_deletions_still_moves_forward():
    s = Scoped()
    fake = FakeNcbi([(str(90003000 + i), article(str(90003000 + i))) for i in range(20)])
    fake.drop_from_window = 3           # efetch returns 7 of the 10 asked for
    run = harvest.harvest(s, fake, fresh_query(s), batch=10)
    assert run.state == "done", "a short window looped instead of advancing"
    assert run.cursor == 20
    assert run.fetched == 14
    s.rollback()


@test
def test_an_expired_history_is_searched_again_from_the_same_place():
    s = Scoped()
    fake = FakeNcbi([(str(90004000 + i), article(str(90004000 + i))) for i in range(20)])
    run = harvest.start(s, fake, fresh_query(s))
    harvest.advance(s, fake, run, batches=1, batch=10)
    fake.expire_history_once = True
    harvest.advance(s, fake, run, batches=1, batch=10)
    assert fake.calls["esearch"] == 2, "the history was not re-established"
    assert run.webenv == "W2"
    assert run.cursor == 20, "the cursor moved backwards after a re-search"
    assert s.query(Source).filter(Source.pmid.like("90004%")).count() == 20
    s.rollback()


@test
def test_an_outage_pauses_a_run_rather_than_losing_it():
    s = Scoped()

    class Down(FakeNcbi):
        def efetch_history(self, *a, **kw):
            raise ncbi.NcbiUnavailable("circuit open")

    fake = Down([(str(90005000 + i), article(str(90005000 + i))) for i in range(5)])
    run = harvest.start(s, fake, fresh_query(s))
    try:
        harvest.advance(s, fake, run, batches=1, batch=10)
    except ncbi.NcbiUnavailable:
        pass
    else:
        raise AssertionError("an outage was swallowed")
    assert run.state == "paused"
    assert run.cursor == 0, "a paused run must resume where it stopped"
    s.rollback()


@test
def test_a_finished_run_moves_the_high_water_mark():
    s = Scoped()
    query = fresh_query(s)
    fake = FakeNcbi([("90006001", article("90006001"))])
    run = harvest.harvest(s, fake, query)
    s.commit()
    assert query.high_water == run.edat_to
    assert query.high_water, "an empty mark would re-harvest everything next time"

    # the next run asks only for what has appeared since
    harvest.start(s, fake, query)
    s.rollback()


@test
def test_a_capped_run_leaves_the_high_water_mark_alone():
    s = Scoped()
    query = fresh_query(s)
    fake = FakeNcbi([(str(90007000 + i), article(str(90007000 + i))) for i in range(50)],
                    count=1200)
    run = harvest.harvest(s, fake, query, max_records=20, batch=10)
    s.commit()
    assert run.state == "done"
    assert run.cursor == 20
    assert run.total == 1200, "the true size of the result should still be recorded"
    assert query.high_water == "", "a look at 20 of 1,200 must not claim the other 1,180"
    assert run.fetched == 20, f"a capped run pulled {run.fetched} records to keep 20"
    s.rollback()


@test
def test_a_cap_smaller_than_a_batch_asks_for_only_what_it_wants():
    s = Scoped()
    asked = []

    class Watching(FakeNcbi):
        def efetch_history(self, search, retstart, retmax=ncbi.BATCH, db="pubmed"):
            asked.append(retmax)
            return super().efetch_history(search, retstart, retmax, db)

    fake = Watching([(str(90007500 + i), article(str(90007500 + i))) for i in range(300)],
                    count=1200)
    harvest.harvest(s, fake, fresh_query(s), max_records=40, batch=ncbi.BATCH)
    assert asked == [40], f"asked for {asked} to keep 40"
    s.rollback()


# ---- citation chaining -------------------------------------------------------
@test
def test_a_bibliography_becomes_a_corpus():
    s = Scoped()
    cited = [str(90008100 + i) for i in range(5)]
    anchor = article("90008000", title="A reference chapter", refs=cited)
    fake = FakeNcbi([("90008000", anchor)] + [(p, article(p)) for p in cited])

    stats = harvest.harvest_ids(s, fake, ["90008000"])
    assert stats["added"] == 1
    row = s.query(Source).filter(Source.pmid == "90008000").one()
    assert s.query(Citation).filter(Citation.source_id == row.id).count() == 5

    out = harvest.promote_citations(s, fake, row)
    assert out["promoted"] == 5
    assert out["added"] == 5
    assert s.query(Source).filter(Source.pmid.in_(cited)).count() == 5

    # and it does not do it twice
    again = harvest.promote_citations(s, fake, row)
    assert again["promoted"] == 0
    s.rollback()


# ---- licence, full text, mis-attribution -------------------------------------
@test
def test_a_source_with_no_pmc_id_is_never_asked_for_full_text():
    s = Scoped()
    row, _ = harvest.upsert(s, ncbi.parse_records(wrap([article("90009000")]))[0])
    fake = FakeNcbi([])
    assert harvest.enrich(s, fake, row) == "no-pmcid"
    assert fake.calls["oa"] == 0
    assert row.is_oa is False
    assert row.oa_checked_at is not None
    s.rollback()


@test
def test_outside_the_open_access_subset_nothing_is_stored():
    s = Scoped()
    row, _ = harvest.upsert(s, ncbi.parse_records(
        wrap([article("90009010", pmcid="PMC9009010")]))[0])
    fake = FakeNcbi([])                      # oa_records is empty, so: not in the subset
    assert harvest.enrich(s, fake, row) == "not-oa"
    assert row.is_oa is False
    assert row.fulltext is None
    assert fake.calls["bioc"] == 0, "asked for text we are not allowed to keep"
    s.rollback()


@test
def test_open_access_full_text_is_stored_with_its_licence():
    s = Scoped()
    title = "Sleep quality in polycystic ovary syndrome"
    row, _ = harvest.upsert(s, ncbi.parse_records(
        wrap([article("90009020", pmcid="PMC9009020", title=title)]))[0])
    fake = FakeNcbi([])
    fake.oa_records["PMC9009020"] = {"pmcid": "PMC9009020", "licence": "CC BY",
                                     "retracted": False, "citation": "J Test. 2020"}
    body = f"{title}\n\nWomen with PCOS slept less."
    fake.fulltext["PMC9009020"] = (body, [
        {"offset": 0, "len": len(title), "section": "TITLE", "type": "front"},
        {"offset": len(title) + 2, "len": len(body) - len(title) - 2,
         "section": "RESULTS", "type": "paragraph"}])

    assert harvest.enrich(s, fake, row) == "fulltext"
    assert row.is_oa is True
    assert row.licence == "CC BY"
    assert row.fulltext == body
    assert ncbi.section_at(row.passages, body.index("Women")) == "RESULTS"
    s.rollback()


@test
def test_text_belonging_to_another_paper_is_refused_and_flagged():
    s = Scoped()
    row, _ = harvest.upsert(s, ncbi.parse_records(
        wrap([article("90009030", pmcid="PMC9009030",
                      title="Sleep quality in polycystic ovary syndrome")]))[0])
    fake = FakeNcbi([])
    fake.oa_records["PMC9009030"] = {"pmcid": "PMC9009030", "licence": "CC BY",
                                     "retracted": False, "citation": ""}
    other = "In vitro fertilisation outcomes in a Taiwanese cohort"
    fake.fulltext["PMC9009030"] = (other, [{"offset": 0, "len": len(other),
                                            "section": "TITLE", "type": "front"}])

    assert harvest.enrich(s, fake, row) == "id-mismatch"
    assert row.fulltext is None, "stored one paper's text against another paper's row"
    assert "id_mismatch" in (row.flags or [])
    s.rollback()


@test
def test_an_open_access_paper_bioc_will_not_serve_keeps_its_licence():
    s = Scoped()
    row, _ = harvest.upsert(s, ncbi.parse_records(
        wrap([article("90009050", pmcid="PMC9009050")]))[0])

    class NoBioc(FakeNcbi):
        def bioc(self, pmcid):
            raise ncbi.NcbiError("not XML: '[Error] : No result can be found.'")

    fake = NoBioc([])
    fake.oa_records["PMC9009050"] = {"pmcid": "PMC9009050", "licence": "CC BY",
                                     "retracted": False, "citation": ""}
    assert harvest.enrich(s, fake, row) == "no-fulltext"
    assert row.is_oa is True and row.licence == "CC BY", "lost what the call did answer"
    assert row.fulltext is None
    assert "no_bioc" in (row.flags or [])
    assert row.screen_state == "new", "an abstract is still text to appraise"
    s.rollback()


@test
def test_the_oa_service_can_be_the_one_that_reports_a_retraction():
    s = Scoped()
    row, _ = harvest.upsert(s, ncbi.parse_records(
        wrap([article("90009040", pmcid="PMC9009040")]))[0])
    fake = FakeNcbi([])
    fake.oa_records["PMC9009040"] = {"pmcid": "PMC9009040", "licence": "CC BY",
                                     "retracted": True, "citation": ""}
    harvest.enrich(s, fake, row, want_fulltext=False)
    assert row.retracted is True
    s.rollback()


@test
def test_titles_are_compared_loosely_enough_to_survive_punctuation():
    same = harvest.titles_match(
        "Sleep quality in polycystic ovary syndrome: a cohort study",
        "Sleep quality in polycystic ovary syndrome - a cohort study")
    assert same is True
    assert harvest.titles_match("Sleep quality in PCOS",
                                "In vitro fertilisation outcomes") is False
    assert harvest.titles_match("", "anything") is False
    assert harvest.titles_match("Sleep quality in polycystic ovary syndrome",
                                "Sleep quality in polycystic ovary syndrome among "
                                "reproductive aged women in Taiwan") is True


# ---- retraction after the fact ----------------------------------------------
@test
def test_a_retraction_excludes_the_source_and_unpublishes_its_claims():
    s = Scoped()
    row, _ = harvest.upsert(s, ncbi.parse_records(wrap([article("90010000")]))[0])
    reviewer = Reviewer(email=f"test:{row.id}@example.invalid", password_hash="x")
    s.add(reviewer)
    s.flush()
    claim = Claim(source_id=row.id, state="published", claim_text="less sleep, more fog")
    s.add(claim)
    s.flush()
    s.add(Published(claim_id=claim.id, correlation_id="sleep_brainfog",
                    display_text="Shorter sleep tracks with more brain fog",
                    published_by=reviewer.id))
    s.commit()

    fake = FakeNcbi([("90010000", article("90010000", retracted=True))])
    out = harvest.sweep(s, fake)
    s.commit()

    assert out["retracted"] == ["90010000"]
    assert out["revoked"] == 1
    assert row.retracted is True
    assert row.screen_state == "excluded"
    published = s.query(Published).filter(Published.claim_id == claim.id).one()
    assert published.revoked_at is not None
    assert "retracted" in published.revoked_reason
    s.rollback()


@test
def test_a_sweep_that_finds_nothing_changes_nothing():
    s = Scoped()
    row, _ = harvest.upsert(s, ncbi.parse_records(wrap([article("90010010")]))[0])
    s.commit()
    fake = FakeNcbi([("90010010", article("90010010"))])
    out = harvest.sweep(s, fake)
    assert out["retracted"] == []
    assert out["revoked"] == 0
    assert row.retracted is False
    assert row.screen_state == "new"
    s.rollback()


@test
def test_revoking_twice_does_not_double_count():
    s = Scoped()
    row, _ = harvest.upsert(s, ncbi.parse_records(wrap([article("90010020")]))[0])
    claim = Claim(source_id=row.id, state="published")
    s.add(claim)
    s.flush()
    s.add(Published(claim_id=claim.id, display_text="something"))
    s.commit()
    assert harvest.revoke_published(s, row, "first") == 1
    assert harvest.revoke_published(s, row, "second") == 0
    s.rollback()


# ---- the seeds themselves ----------------------------------------------------
@test
def test_every_seed_says_which_fields_it_exists_for():
    for seed in harvest.SEEDS:
        assert seed["informs"], f"{seed['name']} informs nothing"
        assert "Polycystic Ovary Syndrome" in seed["term"], seed["name"]
        assert "polyendocrine" in seed["term"], f"{seed['name']} misses the new name"
        assert "[dp]" in seed["term"], f"{seed['name']} has no year floor"


@test
def test_seeds_are_added_once_and_are_not_rewritten_afterwards():
    s = Scoped()
    before = s.query(Query).count()
    added = harvest.ensure_seeds(s)
    assert added + before == s.query(Query).count()
    row = s.query(Query).filter(Query.name == "sleep").one()
    row.term = "edited by hand"
    s.commit()
    assert harvest.ensure_seeds(s) == 0
    assert row.term == "edited by hand", "a stored query must stay reproducible"
    s.rollback()


@test
def test_the_fields_the_seeds_claim_to_inform_are_real_fields():
    """The vocabulary comes from the patient app's own contract, so a seed that
    names a field nobody records is caught here rather than by a reviewer."""
    import vocab
    try:
        known = vocab.field_keys()
    except Exception as e:
        raise AssertionError(f"needs the patient app up for GET /record/schema: {e}")
    for seed in harvest.SEEDS:
        unknown = [f for f in seed["informs"] if f not in known]
        assert not unknown, f"{seed['name']} informs {unknown}, which record.py does not have"


if __name__ == "__main__":
    passed = failed = 0
    for name, fn in T:
        mark = connection.begin_nested()
        try:
            fn(); passed += 1
        except AssertionError as e:
            failed += 1; print(f"FAIL {name}: {e}")
        except Exception as e:
            failed += 1; print(f"ERROR {name}: {type(e).__name__}: {e}")
        finally:
            while _open:
                _open.pop().close()
            mark.rollback()
    outer.rollback()
    connection.close()
    print(f"{passed} passed, {failed} failed")
    raise SystemExit(1 if failed else 0)
