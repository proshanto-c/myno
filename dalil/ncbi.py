"""
Dalīl — the only module that talks to NCBI.

Everything that touches the network lives in `Client`; everything that reads a
document is a pure function of bytes. That split is what makes the parsers
testable against fixtures without a fake HTTP layer, and it keeps the rate
limit in exactly one place.

PMC's terms allow retrieval only through their own services — "systematic
retrieval (or bulk retrieval) of articles through any other automated process
is prohibited" — so this is an API client and never a scraper. Three URL
requests a second without a key, ten with one, and `tool` and `email` on every
request, as they ask.

The parser trap, which already mis-cited a chapter once during development:
`NBK459251` (StatPearls, "Polyendocrine Metabolic Ovarian Syndrome") carries 55
references, and a naive `.//ArticleId` sweep pulls 81 identifiers out of it —
79 of them belonging to papers it cites. Filing a claim from the chapter under
one of those is the worst failure this module could produce, so every
identifier read here is scoped to the record's own list. Never `.//`.
"""
from __future__ import annotations

import dataclasses
import hashlib
import os
import re
import threading
import time
from typing import Callable, Iterable, Sequence

import httpx
from defusedxml import ElementTree as DET

EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
OA_SERVICE = "https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi"
BIOC = "https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_xml/{pmcid}/unicode"

# Quoted from the E-utilities usage policy: "no more than three URL requests per
# second" without an API key, "up to 10 requests per second" with one.
RATE_NO_KEY = 3.0
RATE_WITH_KEY = 10.0

# And: large jobs belong "either weekends or between 9:00 PM and 5:00 AM Eastern".
BULK_WINDOW_ET = (21, 5)
BULK_THRESHOLD = 200

# efetch takes up to 10,000 ids from the History server; 200 keeps a batch small
# enough that a failure costs little and the cursor advances often.
BATCH = 200

TIMEOUT = 60.0


class NcbiError(RuntimeError):
    """Anything NCBI said no to."""


class NcbiUnavailable(NcbiError):
    """The breaker is open: stop asking for a while."""


# ---- being a good citizen ---------------------------------------------------
class Limiter:
    """A token bucket over the whole process, kept as a schedule rather than a count.

    Counting tokens and looping until one is available spins forever on
    floating-point dust: a bucket that refills to 0.9999999999999999 sleeps for
    a third of a femtosecond, which a float clock cannot represent, so it never
    advances. Tracking the moment the bucket runs dry instead makes each request
    one arithmetic step with no loop in it at all.

    The clock and the sleep are arguments so the limiter can be tested at speed:
    a test asserts that thirty requests consume nine simulated seconds without
    waiting nine real ones.
    """

    def __init__(self, rate: float, clock: Callable[[], float] = time.monotonic,
                 sleeper: Callable[[float], None] = time.sleep, burst: float | None = None):
        self.rate = float(rate)
        self.burst = float(burst if burst is not None else rate)
        self._clock, self._sleep = clock, sleeper
        self._interval = 1.0 / self.rate                            # what one request costs
        self._slack = max(0.0, (self.burst - 1.0) * self._interval)  # how far ahead a burst may run
        self._empty_at = clock()
        self._lock = threading.Lock()

    def take(self, n: float = 1.0) -> None:
        # Sleeping inside the lock is deliberate: the cap is on the whole
        # process, so requests queue rather than all waking at once and firing
        # together the moment a token appears.
        with self._lock:
            now = self._clock()
            empty_at = max(self._empty_at, now)
            wait = empty_at - now - self._slack
            if wait > 1e-9:                       # a sub-nanosecond wait is arithmetic noise
                self._sleep(wait)
                empty_at = max(empty_at, self._clock())
            self._empty_at = empty_at + n * self._interval


class Breaker:
    """Three consecutive failures and we stop for a minute.

    Without this a service outage turns into thousands of failing requests a
    minute, which is exactly the behaviour the usage policy asks callers not to
    have.
    """

    def __init__(self, threshold: int = 3, cooldown: float = 60.0,
                 clock: Callable[[], float] = time.monotonic):
        self.threshold, self.cooldown, self._clock = threshold, cooldown, clock
        self.failures = 0
        self.opened_at = 0.0

    @property
    def open(self) -> bool:
        return self.failures >= self.threshold and self._clock() - self.opened_at < self.cooldown

    def check(self) -> None:
        if self.open:
            left = self.cooldown - (self._clock() - self.opened_at)
            raise NcbiUnavailable(f"circuit open after {self.failures} failures, {left:.0f}s left")

    def succeeded(self) -> None:
        self.failures = 0

    def failed(self) -> None:
        self.failures += 1
        if self.failures >= self.threshold:
            self.opened_at = self._clock()


def bulk_window_ok(hour_et: int | None = None) -> bool:
    """Is it a courteous hour for a big run? Start 21:00, end 05:00 Eastern."""
    if hour_et is None:
        hour_et = _eastern_hour()
    start, end = BULK_WINDOW_ET
    return hour_et >= start or hour_et < end


def _eastern_hour() -> int:
    try:
        from zoneinfo import ZoneInfo
        import datetime as dt
        return dt.datetime.now(ZoneInfo("America/New_York")).hour
    except Exception:
        # No tzdata in the image is not a reason to fail a harvest; an hour
        # either side of a courtesy window changes nothing that matters.
        return (time.gmtime().tm_hour - 5) % 24


# ---- what a record is -------------------------------------------------------
@dataclasses.dataclass
class Record:
    """One paper, chapter or guideline, as PubMed describes it."""
    pmid: str = ""
    pmcid: str = ""
    doi: str = ""
    nbk: str = ""
    kind: str = "article"                    # article | chapter | guideline
    title: str = ""
    abstract: str = ""
    journal: str = ""
    book_title: str = ""
    publisher: str = ""
    year: int | None = None
    authors: list = dataclasses.field(default_factory=list)
    pub_types: list = dataclasses.field(default_factory=list)
    mesh: list = dataclasses.field(default_factory=list)
    sections: list = dataclasses.field(default_factory=list)
    grants: list = dataclasses.field(default_factory=list)
    coi: str = ""
    retracted: bool = False
    retraction_pmid: str = ""
    citations: list = dataclasses.field(default_factory=list)   # [{pmid, doi, raw}]

    def hash(self) -> str:
        """Changes when anything downstream would care. Used to skip re-work."""
        parts = [self.pmid, self.pmcid, self.doi, self.nbk, self.title, self.abstract,
                 self.journal, str(self.year), "|".join(self.pub_types),
                 "|".join(self.mesh), str(self.retracted), str(len(self.citations))]
        return hashlib.sha256("\x1f".join(parts).encode()).hexdigest()

    @property
    def identity(self) -> str:
        return self.pmid or self.pmcid or self.nbk or self.doi or ""


@dataclasses.dataclass
class Search:
    """An esearch that stayed on the History server."""
    webenv: str = ""
    query_key: str = ""
    count: int = 0
    translation: str = ""


# ---- reading XML ------------------------------------------------------------
def _text(node) -> str:
    """All the text under a node, whitespace collapsed.

    Titles and abstracts carry inline markup (`<i>`, `<sup>`, `<b>`), so reading
    `node.text` drops half of some titles.
    """
    if node is None:
        return ""
    return re.sub(r"\s+", " ", "".join(node.itertext())).strip()


def _year_in(*texts) -> int | None:
    for t in texts:
        m = re.search(r"\b(1[89]\d\d|20\d\d|21\d\d)\b", t or "")
        if m:
            return int(m.group(1))
    return None


def norm_pmcid(value: str) -> str:
    value = (value or "").strip().upper()
    if not value:
        return ""
    return value if value.startswith("PMC") else f"PMC{value}"


def norm_doi(value: str) -> str:
    value = (value or "").strip().lower()
    value = re.sub(r"^https?://(dx\.)?doi\.org/", "", value)
    return value.rstrip(" .")


def _own_ids(record) -> dict:
    """The identifiers this record claims for itself, and no others.

    Three scoped paths, never a recursive search: `PubmedData` for articles,
    `PubmedBookData` for a book's PMID and DOI, and `BookDocument` for the
    Bookshelf accession — which is the only id that lives there.
    """
    out: dict[str, str] = {}
    for path in ("./PubmedData/ArticleIdList/ArticleId",
                 "./PubmedBookData/ArticleIdList/ArticleId",
                 "./BookDocument/ArticleIdList/ArticleId"):
        for node in record.findall(path):
            kind = (node.get("IdType") or "").strip().lower()
            value = _text(node)
            if kind and value and kind not in out:
                out[kind] = value
    return out


def _references(record, *paths) -> list:
    """The works a record cites. Read deliberately, and kept apart from `_own_ids`."""
    out = []
    for path in paths:
        for ref in record.findall(path):
            ids = {(a.get("IdType") or "").lower(): _text(a)
                   for a in ref.findall("./ArticleIdList/ArticleId")}
            out.append({"pmid": ids.get("pubmed", ""),
                        "doi": norm_doi(ids.get("doi", "")),
                        "raw": _text(ref.find("Citation"))[:800]})
    return out


def _authors(nodes) -> list:
    out = []
    for a in nodes:
        last = _text(a.find("LastName"))
        initials = _text(a.find("Initials"))
        collective = _text(a.find("CollectiveName"))
        name = collective or (f"{last} {initials}".strip() if last else "")
        if name:
            out.append(name)
    return out


def _abstract(parent) -> str:
    """Structured abstracts keep their labels — "RESULTS:" is worth a reviewer's time."""
    chunks = []
    for node in (parent.findall("./Abstract/AbstractText") if parent is not None else []):
        body = _text(node)
        if not body:
            continue
        label = (node.get("Label") or "").strip()
        chunks.append(f"{label}: {body}" if label else body)
    return "\n\n".join(chunks)


GUIDELINE_TYPES = {"guideline", "practice guideline", "consensus development conference",
                   "consensus development conference, nih", "consensus statement"}


def _kind(pub_types: Sequence[str], is_book: bool) -> str:
    lowered = {p.lower() for p in pub_types}
    if lowered & GUIDELINE_TYPES:
        return "guideline"
    return "chapter" if is_book else "article"


def _parse_article(node) -> Record:
    med = node.find("./MedlineCitation")
    art = med.find("./Article") if med is not None else None
    ids = _own_ids(node)
    pub_types = [_text(p) for p in (art.findall("./PublicationTypeList/PublicationType") if art is not None else [])]
    corrections = [(c.get("RefType") or "", _text(c.find("PMID")))
                   for c in (med.findall("./CommentsCorrectionsList/CommentsCorrections") if med is not None else [])]
    retraction = next((pmid for kind, pmid in corrections if kind == "RetractionIn"), "")

    return Record(
        pmid=ids.get("pubmed", "") or _text(med.find("PMID") if med is not None else None),
        pmcid=norm_pmcid(ids.get("pmc", "")),
        doi=norm_doi(ids.get("doi", "")),
        kind=_kind(pub_types, is_book=False),
        title=_text(art.find("ArticleTitle") if art is not None else None),
        abstract=_abstract(art),
        journal=_text(art.find("./Journal/ISOAbbreviation") if art is not None else None)
                or _text(art.find("./Journal/Title") if art is not None else None),
        year=_year_in(_text(art.find("./Journal/JournalIssue/PubDate/Year") if art is not None else None),
                      _text(art.find("./Journal/JournalIssue/PubDate/MedlineDate") if art is not None else None),
                      _text(art.find("./ArticleDate/Year") if art is not None else None)),
        authors=_authors(art.findall("./AuthorList/Author") if art is not None else []),
        pub_types=pub_types,
        mesh=[_text(m) for m in (med.findall("./MeshHeadingList/MeshHeading/DescriptorName")
                                 if med is not None else [])],
        grants=sorted({_text(g.find("Agency")) for g in
                       (art.findall("./GrantList/Grant") if art is not None else [])} - {""}),
        coi=_text(med.find("CoiStatement") if med is not None else None),
        # "Retracted Publication" is the type the retracted paper itself carries;
        # RetractionIn points at the notice. Either one is authoritative, and
        # both work for records outside the OA subset, where oa.fcgi cannot help.
        retracted=any(p.lower() == "retracted publication" for p in pub_types) or bool(retraction),
        retraction_pmid=retraction,
        citations=_references(node, "./PubmedData/ReferenceList//Reference"),
    )


def _parse_book(node) -> Record:
    doc = node.find("./BookDocument")
    book = doc.find("./Book") if doc is not None else None
    ids = _own_ids(node)
    pub_types = [_text(p) for p in (doc.findall("./PublicationType") if doc is not None else [])]

    return Record(
        pmid=ids.get("pubmed", "") or _text(doc.find("PMID") if doc is not None else None),
        pmcid=norm_pmcid(ids.get("pmc", "")),
        doi=norm_doi(ids.get("doi", "")),
        nbk=ids.get("bookaccession", ""),
        kind=_kind(pub_types, is_book=True),
        title=_text(doc.find("ArticleTitle") if doc is not None else None)
              or _text(book.find("BookTitle") if book is not None else None),
        abstract=_abstract(doc),
        book_title=_text(book.find("BookTitle") if book is not None else None),
        publisher=_text(book.find("./Publisher/PublisherName") if book is not None else None),
        # A living reference work is dated by when this chapter was last revised,
        # not by the edition year of the book it sits in — StatPearls stamps the
        # whole book with the current year, which would make every chapter look new.
        year=_year_in(_text(doc.find("./ContributionDate/Year") if doc is not None else None),
                      _text(book.find("./PubDate/Year") if book is not None else None)),
        authors=_authors(doc.findall("./AuthorList/Author") if doc is not None else []),
        pub_types=pub_types,
        sections=[_text(s) for s in (doc.findall("./Sections/Section/SectionTitle")
                                     if doc is not None else [])],
        citations=_references(node, "./BookDocument/ReferenceList//Reference"),
    )


def parse_records(xml_bytes: bytes) -> list:
    """Both node types, from one efetch. Deleted citations are skipped."""
    root = DET.fromstring(xml_bytes)
    out = []
    for node in root:
        if node.tag == "PubmedArticle":
            out.append(_parse_article(node))
        elif node.tag == "PubmedBookArticle":
            out.append(_parse_book(node))
    return out


def parse_esearch(xml_bytes: bytes) -> Search:
    root = DET.fromstring(xml_bytes)
    error = root.findtext("ERROR")
    if error:
        raise NcbiError(f"esearch: {error}")
    return Search(webenv=root.findtext("WebEnv") or "",
                  query_key=root.findtext("QueryKey") or "",
                  count=int(root.findtext("Count") or 0),
                  translation=_text(root.find("QueryTranslation")))


def parse_esearch_ids(xml_bytes: bytes) -> list:
    root = DET.fromstring(xml_bytes)
    return [_text(i) for i in root.findall("./IdList/Id")]


def parse_oa(xml_bytes: bytes) -> dict | None:
    """The two questions worth asking per article: what licence, and retracted?

    Returns None when the identifier is not in the Open Access subset — which is
    the same answer the service gives for one that does not exist at all, so a
    None here means "no full text for us", never "no such paper".
    """
    root = DET.fromstring(xml_bytes)
    if root.find("error") is not None:
        return None
    record = root.find("./records/record")
    if record is None:
        return None
    return {"pmcid": norm_pmcid(record.get("id") or ""),
            "licence": (record.get("license") or "").strip(),
            "retracted": (record.get("retracted") or "").strip().lower() == "yes",
            "citation": (record.get("citation") or "").strip()}


# A reference list is not evidence. Keeping REF passages out of the stored text
# stops a quote from matching the title of a paper this one merely cites — the
# same mis-citation the scoped id read prevents, one layer up.
SKIP_SECTIONS = ("REF",)


def parse_bioc(xml_bytes: bytes, skip: Sequence[str] = SKIP_SECTIONS) -> tuple:
    """Full text plus where each part of it came from.

    The offsets returned are into the string this function returns, not into
    BioC's own coordinate space: a stored offset has to index the stored text or
    quote verification is checking the wrong document.
    """
    root = DET.fromstring(xml_bytes)
    parts, passages, cursor = [], [], 0
    for passage in root.findall(".//passage"):
        infons = {i.get("key"): (i.text or "") for i in passage.findall("infon")}
        section = (infons.get("section_type") or "").upper()
        text = passage.findtext("text") or ""
        if not text.strip() or section in skip:
            continue
        passages.append({"offset": cursor, "len": len(text), "section": section,
                         "type": infons.get("type", "")})
        parts.append(text)
        cursor += len(text) + 2                     # the "\n\n" that joins them
    return "\n\n".join(parts), passages


def section_at(passages: Iterable[dict], offset: int) -> str:
    """Which section an offset landed in — "RESULTS" beats "character 8,412"."""
    for p in passages or []:
        if p["offset"] <= offset < p["offset"] + p["len"]:
            return p.get("section", "")
    return ""


# ---- the network ------------------------------------------------------------
class Client:
    """Every request to NCBI goes through here, and none go anywhere else."""

    def __init__(self, tool: str = "", email: str = "", api_key: str = "",
                 http: httpx.Client | None = None, clock: Callable[[], float] = time.monotonic,
                 sleeper: Callable[[float], None] = time.sleep, retries: int = 3):
        self.tool = tool or os.environ.get("NCBI_TOOL", "tawaazun-dalil")
        self.email = email or os.environ.get("NCBI_EMAIL", "")
        self.api_key = api_key or os.environ.get("NCBI_API_KEY", "")
        self.retries = retries
        self._sleep = sleeper
        self._owns_http = http is None
        self.http = http or httpx.Client(timeout=TIMEOUT, follow_redirects=True,
                                         headers={"User-Agent": f"{self.tool} (+{self.email})"})
        self.limiter = Limiter(RATE_WITH_KEY if self.api_key else RATE_NO_KEY,
                               clock=clock, sleeper=sleeper)
        self.breaker = Breaker(clock=clock)
        self.requests = 0

    def close(self) -> None:
        if self._owns_http:
            self.http.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def _identify(self, params: dict) -> dict:
        out = dict(params)
        out["tool"] = self.tool
        if self.email:
            out["email"] = self.email
        if self.api_key:
            out["api_key"] = self.api_key
        return out

    def _request(self, url: str, params: dict, post: bool = False) -> bytes:
        self.breaker.check()
        params = self._identify(params)
        last = None
        for attempt in range(self.retries):
            self.limiter.take()
            self.requests += 1
            try:
                if post:
                    reply = self.http.post(url, data=params)
                else:
                    reply = self.http.get(url, params=params)
            except httpx.HTTPError as e:
                last = NcbiError(f"{url}: {e}")
                self.breaker.failed()
                self._sleep(min(2 ** attempt, 8))
                continue

            if reply.status_code == 429 or reply.status_code >= 500:
                # Retry-After is the server telling us the answer; guessing over
                # the top of it is how a caller gets blocked.
                wait = _retry_after(reply.headers.get("retry-after")) or min(2 ** attempt, 8)
                last = NcbiError(f"{url}: HTTP {reply.status_code}")
                self.breaker.failed()
                self._sleep(wait)
                continue
            if reply.status_code >= 400:
                self.breaker.succeeded()          # a 404 is an answer, not an outage
                raise NcbiError(f"{url}: HTTP {reply.status_code}")

            self.breaker.succeeded()
            return reply.content
        raise last or NcbiError(f"{url}: gave up after {self.retries} attempts")

    # -- E-utilities ----------------------------------------------------------
    def esearch(self, term: str, db: str = "pubmed", mindate: str = "", maxdate: str = "",
                datetype: str = "edat", retmax: int = 0) -> Search:
        """Search, and leave the result on the History server.

        Broad PMOS terms return tens of thousands of records; pulling ids back
        through the client would be a second copy of a list NCBI is already
        holding for us.
        """
        params = {"db": db, "term": term, "usehistory": "y", "retmax": retmax, "retmode": "xml"}
        if mindate:
            params.update(datetype=datetype, mindate=mindate, maxdate=maxdate or "3000/12/31")
        return parse_esearch(self._request(f"{EUTILS}/esearch.fcgi", params))

    def efetch_history(self, search: Search, retstart: int, retmax: int = BATCH,
                       db: str = "pubmed") -> bytes:
        return self._request(f"{EUTILS}/efetch.fcgi", {
            "db": db, "WebEnv": search.webenv, "query_key": search.query_key,
            "retstart": retstart, "retmax": retmax, "retmode": "xml"})

    def efetch_ids(self, ids: Sequence[str], db: str = "pubmed") -> bytes:
        """POST past a hundred ids: a GET of a thousand PMIDs is a URL no proxy
        along the way is obliged to carry."""
        ids = [str(i) for i in ids if i]
        if not ids:
            return b"<PubmedArticleSet/>"
        params = {"db": db, "id": ",".join(ids), "retmode": "xml"}
        return self._request(f"{EUTILS}/efetch.fcgi", params, post=len(ids) > 100)

    # -- PMC ------------------------------------------------------------------
    def oa(self, pmcid: str) -> dict | None:
        """One identifier per call — the service rejects a comma-separated list."""
        return parse_oa(self._request(OA_SERVICE, {"id": norm_pmcid(pmcid)}))

    def bioc(self, pmcid: str) -> tuple:
        return parse_bioc(self._request(BIOC.format(pmcid=norm_pmcid(pmcid)), {}))


def _retry_after(value: str | None) -> float:
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return 0.0
