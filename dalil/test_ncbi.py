"""
The NCBI client, tested without NCBI.

Run:  docker compose exec -T dalil python test_ncbi.py
      LIVE=1 docker compose exec -T dalil python test_ncbi.py   # two real calls

Parsers run against inline fixtures cut down from real efetch output — the book
fixture keeps a reference list carrying foreign identifiers, because that is the
shape that mis-cited a chapter during development and a tidied-up fixture would
stop catching it. The limiter runs on an injected clock, so thirty requests
worth of throttling take no time at all.
"""
import os

import httpx
from defusedxml import ElementTree as DET

import ncbi

T = []
test = lambda fn: (T.append((fn.__name__, fn)), fn)[1]


# ---- fixtures ---------------------------------------------------------------
# StatPearls, "Polyendocrine Metabolic Ovarian Syndrome" (NBK459251 / PMID
# 29083730), trimmed to three references. The third carries a PMC id belonging
# to a paper the chapter *cites*; the chapter itself has none.
BOOK_XML = b"""<?xml version="1.0" ?>
<PubmedArticleSet>
<PubmedBookArticle>
 <BookDocument>
  <PMID Version="1">29083730</PMID>
  <ArticleIdList><ArticleId IdType="bookaccession">NBK459251</ArticleId></ArticleIdList>
  <Book>
   <Publisher><PublisherName>StatPearls Publishing</PublisherName>
    <PublisherLocation>Treasure Island (FL)</PublisherLocation></Publisher>
   <BookTitle book="statpearls">StatPearls</BookTitle>
   <PubDate><Year>2026</Year><Month>01</Month></PubDate>
   <Medium>Internet</Medium>
  </Book>
  <ArticleTitle>Polyendocrine Metabolic Ovarian Syndrome</ArticleTitle>
  <Language>eng</Language>
  <AuthorList>
   <Author><LastName>Shukla</LastName><ForeName>Anukrati</ForeName><Initials>A</Initials></Author>
   <Author><LastName>Rasquin</LastName><ForeName>Lorena I.</ForeName><Initials>LI</Initials></Author>
  </AuthorList>
  <PublicationType>Study Guide</PublicationType>
  <Abstract><AbstractText>Polyendocrine metabolic ovarian syndrome (PMOS), which was
   recently <i>renamed</i> from polycystic ovary syndrome, is a common endocrine
   disorder.</AbstractText>
   <CopyrightInformation>Copyright &#169; 2026, StatPearls Publishing LLC.</CopyrightInformation></Abstract>
  <Sections>
   <Section><SectionTitle>Introduction</SectionTitle></Section>
   <Section><SectionTitle>Evaluation</SectionTitle></Section>
   <Section><SectionTitle>References</SectionTitle></Section>
  </Sections>
  <ContributionDate><Year>2025</Year><Month>7</Month><Day>7</Day></ContributionDate>
  <ReferenceList>
   <Reference><Citation>Teede HJ, Khomami MB, Morman R, et al. Polyendocrine metabolic
     ovarian syndrome, the new name for polycystic ovary syndrome.</Citation>
    <ArticleIdList><ArticleId IdType="pubmed">42119588</ArticleId></ArticleIdList></Reference>
   <Reference><Citation>Bozdag G, Mumusoglu S, Zengin D, et al. The prevalence and
     phenotypic features of polycystic ovary syndrome.</Citation>
    <ArticleIdList><ArticleId IdType="pubmed">27664216</ArticleId></ArticleIdList></Reference>
   <Reference><Citation>Ding DC, Chen W, Wang JH, Lin SZ. Association between polycystic
     ovarian syndrome and endometrial cancer.</Citation>
    <ArticleIdList><ArticleId IdType="pmc">PMC6181615</ArticleId>
     <ArticleId IdType="pubmed">30278576</ArticleId></ArticleIdList></Reference>
  </ReferenceList>
 </BookDocument>
 <PubmedBookData>
  <PublicationStatus>ppublish</PublicationStatus>
  <ArticleIdList><ArticleId IdType="pubmed">29083730</ArticleId></ArticleIdList>
 </PubmedBookData>
</PubmedBookArticle>
</PubmedArticleSet>"""

# PMID 30278576, an observational study, with a structured-looking title that
# carries inline markup and a PMC id of its own.
ARTICLE_XML = b"""<?xml version="1.0" ?>
<PubmedArticleSet>
<PubmedArticle>
 <MedlineCitation Status="MEDLINE">
  <PMID Version="1">30278576</PMID>
  <Article PubModel="Print">
   <Journal><ISSN>1536-5964</ISSN>
    <JournalIssue><Volume>97</Volume><Issue>39</Issue>
     <PubDate><Year>2018</Year><Month>Sep</Month></PubDate></JournalIssue>
    <Title>Medicine</Title><ISOAbbreviation>Medicine (Baltimore)</ISOAbbreviation></Journal>
   <ArticleTitle>Association between polycystic ovarian syndrome and
     endometrial cancer: a <i>nationwide</i> cohort</ArticleTitle>
   <Abstract>
    <AbstractText Label="BACKGROUND">PCOS is a common endocrine disorder.</AbstractText>
    <AbstractText Label="RESULTS">Women with PCOS had a higher risk (HR 2.62,
      95% CI 1.77-3.88).</AbstractText>
   </Abstract>
   <AuthorList><Author><LastName>Ding</LastName><Initials>DC</Initials></Author>
    <Author><LastName>Chen</LastName><Initials>W</Initials></Author></AuthorList>
   <PublicationTypeList><PublicationType>Journal Article</PublicationType>
    <PublicationType>Observational Study</PublicationType></PublicationTypeList>
   <GrantList><Grant><Agency>Tzu Chi</Agency></Grant>
    <Grant><Agency>Tzu Chi</Agency></Grant></GrantList>
  </Article>
  <MeshHeadingList>
   <MeshHeading><DescriptorName UI="D011085">Polycystic Ovary Syndrome</DescriptorName></MeshHeading>
   <MeshHeading><DescriptorName UI="D016889">Endometrial Neoplasms</DescriptorName></MeshHeading>
  </MeshHeadingList>
  <CoiStatement>The authors report no conflicts of interest.</CoiStatement>
 </MedlineCitation>
 <PubmedData>
  <ArticleIdList>
   <ArticleId IdType="pubmed">30278576</ArticleId>
   <ArticleId IdType="pmc">PMC6181615</ArticleId>
   <ArticleId IdType="doi">10.1097/MD.0000000000012608</ArticleId>
  </ArticleIdList>
  <ReferenceList>
   <Reference><Citation>Azziz R. PCOS in 2015.</Citation>
    <ArticleIdList><ArticleId IdType="pubmed">26597964</ArticleId></ArticleIdList></Reference>
  </ReferenceList>
 </PubmedData>
</PubmedArticle>
</PubmedArticleSet>"""

RETRACTED_XML = b"""<?xml version="1.0" ?>
<PubmedArticleSet>
<PubmedArticle>
 <MedlineCitation>
  <PMID Version="1">40099263</PMID>
  <Article><Journal><Title>J Ovarian Res</Title>
    <JournalIssue><PubDate><MedlineDate>2025 Mar-Apr</MedlineDate></PubDate></JournalIssue></Journal>
   <ArticleTitle>Integrated multi-omics analysis of complement component 3.</ArticleTitle>
   <PublicationTypeList><PublicationType>Journal Article</PublicationType>
    <PublicationType>Retracted Publication</PublicationType></PublicationTypeList></Article>
  <CommentsCorrectionsList>
   <CommentsCorrections RefType="RetractionIn"><PMID Version="1">42325614</PMID></CommentsCorrections>
  </CommentsCorrectionsList>
 </MedlineCitation>
 <PubmedData><ArticleIdList><ArticleId IdType="pubmed">40099263</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle>
</PubmedArticleSet>"""

# The 2023-lineage consensus statement that renamed the condition.
GUIDELINE_XML = b"""<?xml version="1.0" ?>
<PubmedArticleSet><PubmedArticle>
 <MedlineCitation><PMID Version="1">42119588</PMID>
  <Article><Journal><ISOAbbreviation>Lancet</ISOAbbreviation>
    <JournalIssue><PubDate><Year>2026</Year></PubDate></JournalIssue></Journal>
   <ArticleTitle>Polyendocrine metabolic ovarian syndrome, the new name for
     polycystic ovary syndrome.</ArticleTitle>
   <PublicationTypeList><PublicationType>Journal Article</PublicationType>
    <PublicationType>Consensus Statement</PublicationType>
    <PublicationType>Review</PublicationType></PublicationTypeList>
   <AuthorList><Author><CollectiveName>International PCOS Network</CollectiveName></Author></AuthorList>
  </Article></MedlineCitation>
 <PubmedData><ArticleIdList><ArticleId IdType="pubmed">42119588</ArticleId></ArticleIdList></PubmedData>
</PubmedArticle></PubmedArticleSet>"""

ESEARCH_XML = b"""<?xml version="1.0" ?>
<eSearchResult><Count>271</Count><RetMax>0</RetMax><RetStart>0</RetStart>
<QueryKey>1</QueryKey><WebEnv>MCID_6a8772b8feaee4b663088ffd</WebEnv><IdList/>
<QueryTranslation>"polycystic ovary syndrome"[All Fields] AND "sleep"[MeSH Terms]</QueryTranslation>
</eSearchResult>"""

OA_XML = b"""<OA><responseDate>2026-08-20 17:33:44</responseDate>
<records returned-count="1" total-count="1">
<record id="PMC6181615" citation="Medicine (Baltimore). 2018 Sep 28; 97(39):e12608"
        license="CC BY-NC-ND" retracted="no">
 <link format="pdf" href="ftp://ftp.ncbi.nlm.nih.gov/pub/pmc/oa_pdf/93/53/x.pdf" /></record>
</records></OA>"""

OA_MISSING_XML = b"""<OA><responseDate>2026-08-20 17:34:42</responseDate>
<error code="idDoesNotExist">identifier 'PMC99999999' does not exist</error></OA>"""

BIOC_XML = b"""<collection><document><id>6181615</id>
 <passage><infon key="section_type">TITLE</infon><infon key="type">front</infon>
  <offset>0</offset><text>Association between PCOS and endometrial cancer</text></passage>
 <passage><infon key="section_type">ABSTRACT</infon><infon key="type">abstract</infon>
  <offset>92</offset><text>PCOS is a common endocrine disorder.</text></passage>
 <passage><infon key="section_type">RESULTS</infon><infon key="type">paragraph</infon>
  <offset>400</offset><text>Women with PCOS had a higher risk of endometrial cancer.</text></passage>
 <passage><infon key="section_type">REF</infon><infon key="type">ref</infon>
  <offset>900</offset><text>Azziz R. Sleep and brain fog in PCOS. Lancet. 2015.</text></passage>
</document></collection>"""


# ---- the trap ---------------------------------------------------------------
@test
def test_a_chapters_own_ids_are_its_own_and_not_its_references():
    node = DET.fromstring(BOOK_XML).find("PubmedBookArticle")
    sweep = [(a.get("IdType"), (a.text or "").strip()) for a in node.iter("ArticleId")]
    # the fixture has to still contain the trap, or this test guards nothing
    assert ("pmc", "PMC6181615") in sweep, "fixture no longer carries a foreign PMC id"

    rec = ncbi.parse_records(BOOK_XML)[0]
    assert rec.pmid == "29083730"
    assert rec.nbk == "NBK459251"
    assert rec.pmcid == "", f"picked up a cited paper's PMC id: {rec.pmcid}"
    assert rec.doi == ""


@test
def test_the_references_are_kept_but_kept_separate():
    rec = ncbi.parse_records(BOOK_XML)[0]
    assert len(rec.citations) == 3
    assert [c["pmid"] for c in rec.citations] == ["42119588", "27664216", "30278576"]
    assert "Teede" in rec.citations[0]["raw"]
    # the PMC id in the third reference belongs to the reference, not to us
    assert rec.pmcid == ""


@test
def test_a_reference_work_is_dated_by_when_it_was_revised():
    rec = ncbi.parse_records(BOOK_XML)[0]
    # Book/PubDate says 2026 — the edition, stamped on every chapter alike
    assert rec.year == 2025, "took the book's edition year over the chapter's revision"


@test
def test_a_chapter_carries_its_shape():
    rec = ncbi.parse_records(BOOK_XML)[0]
    assert rec.kind == "chapter"
    assert rec.book_title == "StatPearls"
    assert rec.publisher == "StatPearls Publishing"
    assert rec.title == "Polyendocrine Metabolic Ovarian Syndrome"
    assert rec.sections == ["Introduction", "Evaluation", "References"]
    assert rec.authors == ["Shukla A", "Rasquin LI"]
    assert "renamed" in rec.abstract, "inline markup swallowed the text around it"


# ---- articles ---------------------------------------------------------------
@test
def test_an_article_parses_whole():
    rec = ncbi.parse_records(ARTICLE_XML)[0]
    assert rec.pmid == "30278576"
    assert rec.pmcid == "PMC6181615"
    assert rec.doi == "10.1097/md.0000000000012608", rec.doi
    assert rec.journal == "Medicine (Baltimore)"
    assert rec.year == 2018
    assert rec.kind == "article"
    assert rec.pub_types == ["Journal Article", "Observational Study"]
    assert rec.mesh == ["Polycystic Ovary Syndrome", "Endometrial Neoplasms"]
    assert rec.authors == ["Ding DC", "Chen W"]
    assert rec.grants == ["Tzu Chi"], "a repeated funder should count once"
    assert rec.coi.startswith("The authors report")
    assert [c["pmid"] for c in rec.citations] == ["26597964"]


@test
def test_a_title_survives_its_own_markup():
    rec = ncbi.parse_records(ARTICLE_XML)[0]
    assert rec.title.endswith("a nationwide cohort"), rec.title
    assert "<i>" not in rec.title


@test
def test_a_structured_abstract_keeps_its_labels():
    rec = ncbi.parse_records(ARTICLE_XML)[0]
    assert rec.abstract.startswith("BACKGROUND: ")
    assert "RESULTS: Women with PCOS" in rec.abstract
    # a reviewer needs to see which half of the abstract a quote came from
    assert rec.abstract.count("\n\n") == 1


@test
def test_a_guideline_is_recognised_by_its_publication_type():
    rec = ncbi.parse_records(GUIDELINE_XML)[0]
    assert rec.kind == "guideline"
    assert rec.authors == ["International PCOS Network"], "a collective author was dropped"


@test
def test_both_record_types_come_back_from_one_fetch():
    mixed = BOOK_XML.replace(b"</PubmedArticleSet>", b"") + \
        ARTICLE_XML.split(b"<PubmedArticleSet>")[1]
    kinds = [r.kind for r in ncbi.parse_records(mixed)]
    assert kinds == ["chapter", "article"], kinds


@test
def test_a_year_survives_a_medline_date():
    rec = ncbi.parse_records(RETRACTED_XML)[0]
    assert rec.year == 2025, "a '2025 Mar-Apr' date has a year in it"


# ---- retraction -------------------------------------------------------------
@test
def test_retraction_is_read_from_either_signal():
    rec = ncbi.parse_records(RETRACTED_XML)[0]
    assert rec.retracted is True
    assert rec.retraction_pmid == "42325614"

    # each signal alone is enough — non-OA records only ever carry one
    only_type = RETRACTED_XML.replace(b"<CommentsCorrectionsList>", b"<Unused>") \
                             .replace(b"</CommentsCorrectionsList>", b"</Unused>")
    assert ncbi.parse_records(only_type)[0].retracted is True
    only_notice = RETRACTED_XML.replace(b"<PublicationType>Retracted Publication</PublicationType>", b"")
    assert ncbi.parse_records(only_notice)[0].retracted is True


@test
def test_an_ordinary_paper_is_not_retracted():
    assert ncbi.parse_records(ARTICLE_XML)[0].retracted is False


# ---- identifiers ------------------------------------------------------------
@test
def test_identifiers_are_normalised_to_one_spelling():
    assert ncbi.norm_pmcid("6181615") == "PMC6181615"
    assert ncbi.norm_pmcid("pmc6181615") == "PMC6181615"
    assert ncbi.norm_pmcid(" PMC6181615 ") == "PMC6181615"
    assert ncbi.norm_pmcid("") == ""
    assert ncbi.norm_doi("https://doi.org/10.1097/MD.X") == "10.1097/md.x"
    assert ncbi.norm_doi("http://dx.doi.org/10.1/A") == "10.1/a"
    assert ncbi.norm_doi("10.1/B.") == "10.1/b"


@test
def test_a_records_hash_moves_only_when_something_downstream_would_care():
    a = ncbi.parse_records(ARTICLE_XML)[0]
    b = ncbi.parse_records(ARTICLE_XML)[0]
    assert a.hash() == b.hash()
    b.abstract += " One more sentence."
    assert a.hash() != b.hash()
    c = ncbi.parse_records(ARTICLE_XML)[0]
    c.coi = "changed"          # not part of what we re-derive from
    assert a.hash() == c.hash()


@test
def test_identity_prefers_the_id_a_person_would_quote():
    rec = ncbi.parse_records(BOOK_XML)[0]
    assert rec.identity == "29083730"
    rec.pmid = ""
    assert rec.identity == "NBK459251"


# ---- the other services -----------------------------------------------------
@test
def test_an_esearch_keeps_its_place_on_the_history_server():
    s = ncbi.parse_esearch(ESEARCH_XML)
    assert s.count == 271
    assert s.webenv.startswith("MCID_")
    assert s.query_key == "1"
    assert "sleep" in s.translation


@test
def test_an_esearch_error_is_raised_not_returned_as_zero_results():
    bad = b"<eSearchResult><ERROR>Invalid db name</ERROR><Count>0</Count></eSearchResult>"
    try:
        ncbi.parse_esearch(bad)
    except ncbi.NcbiError as e:
        assert "Invalid db" in str(e)
    else:
        raise AssertionError("a search that failed looked like a search that found nothing")


@test
def test_the_oa_service_answers_licence_and_retraction():
    oa = ncbi.parse_oa(OA_XML)
    assert oa["pmcid"] == "PMC6181615"
    assert oa["licence"] == "CC BY-NC-ND"
    assert oa["retracted"] is False
    assert "Medicine" in oa["citation"]


@test
def test_not_in_the_open_access_subset_is_none_not_an_error():
    assert ncbi.parse_oa(OA_MISSING_XML) is None


@test
def test_a_plain_text_error_with_a_200_is_read_as_one():
    """BioC answers for an article it does not hold with prose and HTTP 200.
    A bare ParseError tells a reader nothing, so the body comes with it."""
    body = b"[Error] : No result can be found.\n"
    for parser in (ncbi.parse_bioc, ncbi.parse_records, ncbi.parse_oa, ncbi.parse_esearch):
        try:
            parser(body)
        except ncbi.NcbiError as e:
            assert "No result can be found" in str(e), (parser.__name__, str(e))
        else:
            raise AssertionError(f"{parser.__name__} accepted prose as XML")


@test
def test_full_text_offsets_index_the_text_we_store():
    text, passages = ncbi.parse_bioc(BIOC_XML)
    for p in passages:
        chunk = text[p["offset"]:p["offset"] + p["len"]]
        assert len(chunk) == p["len"], f"{p['section']} runs off the end"
    assert text[passages[1]["offset"]:].startswith("PCOS is a common")


@test
def test_the_reference_list_is_left_out_of_the_stored_text():
    text, passages = ncbi.parse_bioc(BIOC_XML)
    # otherwise a quote could match the title of a paper this one merely cites
    assert "Azziz" not in text
    assert [p["section"] for p in passages] == ["TITLE", "ABSTRACT", "RESULTS"]


@test
def test_an_offset_can_be_named_as_a_section():
    text, passages = ncbi.parse_bioc(BIOC_XML)
    at = text.index("Women with PCOS")
    assert ncbi.section_at(passages, at) == "RESULTS"
    assert ncbi.section_at(passages, 0) == "TITLE"
    assert ncbi.section_at(passages, 10_000) == ""


# ---- the rate limit ---------------------------------------------------------
class FakeClock:
    """Time only moves when something sleeps."""

    def __init__(self):
        self.now = 0.0
        self.slept = []

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.now += seconds


@test
def test_thirty_requests_cost_nine_seconds_at_three_a_second():
    c = FakeClock()
    limiter = ncbi.Limiter(ncbi.RATE_NO_KEY, clock=c.clock, sleeper=c.sleep)
    for _ in range(30):
        limiter.take()
    # a full bucket lets the first three through, then it is one every third second
    assert abs(c.now - 9.0) < 1e-6, c.now
    assert len(c.slept) == 27


@test
def test_a_key_buys_the_higher_rate():
    c = FakeClock()
    limiter = ncbi.Limiter(ncbi.RATE_WITH_KEY, clock=c.clock, sleeper=c.sleep)
    for _ in range(30):
        limiter.take()
    assert abs(c.now - 2.0) < 1e-6, c.now


@test
def test_idle_time_refills_the_bucket_but_does_not_bank_it():
    c = FakeClock()
    limiter = ncbi.Limiter(3.0, clock=c.clock, sleeper=c.sleep)
    c.now = 1000.0                       # a long quiet spell
    for _ in range(3):
        limiter.take()
    assert c.slept == [], "a rested limiter should not sleep"
    limiter.take()
    assert abs(c.now - 1000.0 - 1 / 3) < 1e-6, "the bucket banked more than its burst"


@test
def test_the_breaker_opens_after_three_failures_and_shuts_again():
    c = FakeClock()
    breaker = ncbi.Breaker(threshold=3, cooldown=60.0, clock=c.clock)
    breaker.check()
    for _ in range(2):
        breaker.failed()
    breaker.check()                      # two is not three
    breaker.failed()
    try:
        breaker.check()
    except ncbi.NcbiUnavailable:
        pass
    else:
        raise AssertionError("three failures did not open the breaker")
    c.now += 61
    breaker.check()                      # the cooldown passed


@test
def test_one_success_forgives_the_failures_before_it():
    breaker = ncbi.Breaker(threshold=3)
    breaker.failed(); breaker.failed()
    breaker.succeeded()
    breaker.failed(); breaker.failed()
    breaker.check()                      # not a third in a row


@test
def test_big_runs_wait_for_the_quiet_hours():
    assert ncbi.bulk_window_ok(21) is True
    assert ncbi.bulk_window_ok(23) is True
    assert ncbi.bulk_window_ok(4) is True
    assert ncbi.bulk_window_ok(5) is False
    assert ncbi.bulk_window_ok(14) is False
    assert ncbi.bulk_window_ok(20) is False


# ---- the client itself ------------------------------------------------------
def fake_client(handler, **kw):
    c = FakeClock()
    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = ncbi.Client(tool="test-tool", email="t@example.invalid", http=http,
                         clock=c.clock, sleeper=c.sleep, **kw)
    return client, c


@test
def test_every_request_says_who_is_asking():
    seen = {}

    def handler(request):
        seen.update(dict(request.url.params))
        return httpx.Response(200, content=ESEARCH_XML)

    client, _ = fake_client(handler)
    client.esearch("polycystic ovary syndrome")
    assert seen["tool"] == "test-tool"
    assert seen["email"] == "t@example.invalid"
    assert seen["usehistory"] == "y"
    assert "api_key" not in seen


@test
def test_a_key_raises_the_rate_and_travels_with_the_request():
    seen = {}

    def handler(request):
        seen.update(dict(request.url.params))
        return httpx.Response(200, content=ESEARCH_XML)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = ncbi.Client(tool="t", email="e", api_key="secret", http=http)
    assert client.limiter.rate == ncbi.RATE_WITH_KEY
    client.esearch("x")
    assert seen["api_key"] == "secret"


@test
def test_a_429_is_retried_after_the_delay_the_server_named():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"Retry-After": "7"}, content=b"slow down")
        return httpx.Response(200, content=ESEARCH_XML)

    client, clock = fake_client(handler)
    search = client.esearch("x")
    assert search.count == 271
    assert calls["n"] == 2
    assert 7 in clock.slept, f"ignored Retry-After: {clock.slept}"


@test
def test_a_404_is_an_answer_and_does_not_trip_the_breaker():
    client, _ = fake_client(lambda r: httpx.Response(404, content=b"no"))
    try:
        client.esearch("x")
    except ncbi.NcbiError as e:
        assert "404" in str(e)
    else:
        raise AssertionError("a 404 was swallowed")
    assert client.breaker.failures == 0, "a missing record should not look like an outage"


@test
def test_a_service_that_keeps_failing_is_left_alone():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(503, content=b"down")

    client, _ = fake_client(handler, retries=3)
    for _ in range(3):
        try:
            client.esearch("x")
        except ncbi.NcbiError:
            pass
    before = calls["n"]
    try:
        client.esearch("x")
    except ncbi.NcbiUnavailable:
        pass
    else:
        raise AssertionError("kept hammering a service that was down")
    assert calls["n"] == before, "the breaker let a request through"


@test
def test_a_long_id_list_goes_by_post():
    method = {}

    def handler(request):
        method["verb"] = request.method
        return httpx.Response(200, content=ARTICLE_XML)

    client, _ = fake_client(handler)
    client.efetch_ids([str(i) for i in range(20)])
    assert method["verb"] == "GET"
    client.efetch_ids([str(i) for i in range(200)])
    assert method["verb"] == "POST", "a 200-id GET is a URL nothing along the way must carry"


@test
def test_fetching_nothing_asks_for_nothing():
    called = {"n": 0}

    def handler(request):
        called["n"] += 1
        return httpx.Response(200, content=ARTICLE_XML)

    client, _ = fake_client(handler)
    assert ncbi.parse_records(client.efetch_ids([])) == []
    assert called["n"] == 0


@test
def test_the_history_server_is_paged_by_retstart():
    seen = []

    def handler(request):
        seen.append(dict(request.url.params))
        return httpx.Response(200, content=ARTICLE_XML)

    client, _ = fake_client(handler)
    search = ncbi.Search(webenv="W", query_key="1", count=500)
    client.efetch_history(search, retstart=200, retmax=200)
    assert seen[0]["WebEnv"] == "W"
    assert seen[0]["retstart"] == "200"
    assert seen[0]["retmax"] == "200"


# ---- two real calls, only when asked ----------------------------------------
@test
def test_live_the_chapter_still_parses_the_way_we_think_it_does():
    if not os.environ.get("LIVE"):
        return
    with ncbi.Client() as client:
        rec = ncbi.parse_records(client.efetch_ids(["29083730"]))[0]
        assert rec.nbk == "NBK459251"
        assert rec.pmcid == "", f"NCBI now gives the chapter a PMC id: {rec.pmcid}"
        assert len(rec.citations) > 40, len(rec.citations)
        oa = client.oa("PMC6181615")
        assert oa and oa["licence"], oa
        assert client.requests == 2


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
