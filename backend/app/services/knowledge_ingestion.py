"""Offline PDF -> chunk pipeline for the architecture/software-engineering reference-book
knowledge base. Deliberately has NO database or embedding-model access in this module (mirrors
architecture_generation.py's "no DB access, plain data in/out" precedent) -- parsing/cleaning/
chunking are pure functions over text, easy to unit-test and to run standalone against a single
book before touching the database at all. The actual embed + tag + insert orchestration lives in
backend/scripts/ingest_knowledge_base.py, which imports these functions.
"""

import re
from dataclasses import dataclass

import pdfplumber
from bs4 import BeautifulSoup

# pdfplumber's default x_tolerance (3) merges adjacent words with no explicit space glyph between
# them into one run (verified against real extraction output on these books, e.g. "pastfewyears"
# instead of "past few years") -- some of these PDFs encode justified text without literal space
# characters, relying on character x-position gaps instead. 1.5 was the tightest tolerance that
# fixed every observed case without introducing spurious splits.
PDF_X_TOLERANCE = 1.5

# Some of these PDFs map a bullet/glyph character to no real Unicode codepoint, so pdfplumber (and
# pypdf) emit the raw PDF character-ID placeholder "(cid:N)" instead -- purely a font-encoding
# artifact of the source file, not real content.
_CID_ARTIFACT_RE = re.compile(r"\(cid:\d+\)")

# A word broken across a line-wrap with a trailing hyphen ("long-\nterm" -> "long-term" was
# already a real hyphen; "docu-\nmentation" should rejoin to "documentation"). Only rejoins when
# the character before the hyphen and after the line break are both lowercase letters, so real
# compound words at a line break (rare, but e.g. "well-\nknown") are left alone since collapsing
# those would be wrong just as often as right -- rejoining unambiguous soft-hyphenation is the
# high-confidence case worth automating.
_HYPHEN_LINEBREAK_RE = re.compile(r"([a-z])-\n([a-z])")

# Heuristic section-heading detection: a short standalone line, either "N Title" / "N.M Title"
# (numbered heading -- matches the "1 What is architecture?" style headings seen in these books)
# or an all-title-case short line with no trailing sentence punctuation. Deliberately conservative
# (few false positives over many false negatives) since a wrong chapter_title on a chunk is worse
# than "Unknown section" -- this is a "where detectable" best-effort, not a guarantee.
#
# The allowed character class includes ?.! since real headings are often phrased as questions
# ("What is architecture?") -- excluding them doesn't make the match "more conservative", it just
# makes the WHOLE line fail to match (both regexes are anchored with $) and silently falls through
# to being treated as ordinary body text, which is a worse failure mode than a heading regex being
# slightly too permissive.
_NUMBERED_HEADING_RE = re.compile(r"^(\d+(?:\.\d+)*)\s+([A-Z][A-Za-z0-9 ,:;'\"()&/?.!-]{2,80})$")
_PLAIN_HEADING_RE = re.compile(r"^([A-Z][A-Za-z0-9 ,:;'\"()&/?.!-]{2,70})$")

MIN_CHUNK_WORDS = 200
MAX_CHUNK_WORDS = 500


@dataclass
class PageText:
    page_number: int  # 1-indexed, human-facing page number
    text: str


@dataclass
class RawChunk:
    text: str
    chapter_title: str | None
    # None for web-sourced (HTML/Markdown) reference-architecture chunks, which have no page
    # concept -- always set for PDF sources (chunk_book).
    page_start: int | None
    page_end: int | None


def extract_pages(pdf_path: str) -> list[PageText]:
    """Extracts cleaned text per page. 1-indexed page numbers (matches what a reader would cite,
    not pdfplumber's 0-indexed page list)."""
    pages: list[PageText] = []
    with pdfplumber.open(pdf_path) as pdf:
        for idx, page in enumerate(pdf.pages):
            raw = page.extract_text(x_tolerance=PDF_X_TOLERANCE) or ""
            pages.append(PageText(page_number=idx + 1, text=_clean_text(raw)))
    return _strip_running_headers(pages)


def _strip_running_headers(pages: list[PageText]) -> list[PageText]:
    """Some PDFs (verified on an AWS whitepaper) repeat a running header as the literal FIRST line
    of every page's extracted text, with no blank line before the real heading that follows it
    (e.g. "Real-Time Communication on AWS AWS Whitepaper\nIntroduction\n..."). Left in place, the
    chunker's heading-detector matches the running header (itself a plausible-looking title-case
    line) rather than the real "Introduction" heading one line down, so every chunk in the document
    ends up mislabeled with the same generic running-header title. Detects a first line repeated
    across a large fraction of pages and strips just that line, letting the real heading underneath
    surface normally -- never touches a first line that varies page to page (the normal case)."""
    if len(pages) < 4:
        return pages
    first_lines = [p.text.split("\n", 1)[0].strip() for p in pages if p.text]
    if not first_lines:
        return pages
    from collections import Counter

    most_common_line, count = Counter(first_lines).most_common(1)[0]
    if not most_common_line or count / len(first_lines) < 0.4:
        return pages  # no dominant repeated line -- normal document, leave untouched
    stripped = []
    for p in pages:
        first, sep, rest = p.text.partition("\n")
        if first.strip() == most_common_line:
            stripped.append(PageText(page_number=p.page_number, text=rest.strip()))
        else:
            stripped.append(p)
    return stripped


def _clean_text(text: str) -> str:
    text = _CID_ARTIFACT_RE.sub("", text)
    text = _HYPHEN_LINEBREAK_RE.sub(r"\1\2", text)
    # Collapse runs of spaces/tabs (never newlines here -- paragraph/line structure is still
    # needed by the chunker below) left behind by the substitutions above.
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


_TOC_DOT_LEADER_RE = re.compile(r"\.\s*\.\s*\.")


def _looks_like_heading(line: str) -> str | None:
    """Returns the heading title if this line looks like a section heading, else None."""
    line = line.strip()
    if not line or len(line) > 90:
        return None
    # A table-of-contents entry ("Chapter Title . . . . . . . 42") matches the heading shape
    # otherwise, since it's a short title-case-ish line -- the dot-leader run is what actually
    # distinguishes it from a real heading.
    if _TOC_DOT_LEADER_RE.search(line):
        return None
    m = _NUMBERED_HEADING_RE.match(line)
    if m:
        return m.group(2).strip()
    # A plain heading candidate must look title-ish (most words capitalized) to avoid matching an
    # ordinary short sentence fragment that happens to lack terminal punctuation. A lone word/
    # slash-joined term (e.g. "Softswitch/PBX", verified as a real sub-heading in a technical
    # whitepaper) is also accepted -- a standalone short line in extracted PDF text is essentially
    # never a coincidental prose fragment (real sentences wrap across the page width), so this
    # doesn't meaningfully raise the false-positive rate the >=2-word case was guarding against.
    m = _PLAIN_HEADING_RE.match(line)
    if m:
        words = line.split()
        if len(words) == 1:
            return line
        capitalized = sum(1 for w in words if w[:1].isupper())
        if capitalized / len(words) >= 0.6:
            return line
    return None


def chunk_book(
    pages: list[PageText],
    min_words: int = MIN_CHUNK_WORDS,
    max_words: int = MAX_CHUNK_WORDS,
) -> list[RawChunk]:
    """Greedily accumulates paragraphs into ~200-500 word chunks, never splitting a paragraph
    across chunks unless that single paragraph alone already exceeds max_words (rare -- a few
    long-prose paragraphs in these books). A chunk boundary is also forced whenever a detected
    section heading is encountered and the current chunk already has content, so a chunk's
    chapter_title is always accurate for everything inside it rather than trailing content
    "borrowed" from the next section. Records the actual page range spanned by each chunk from the
    pages its paragraphs came from."""
    chunks: list[RawChunk] = []
    current_paragraphs: list[str] = []
    current_pages: list[int] = []
    current_heading: str | None = None

    def flush() -> None:
        if not current_paragraphs:
            return
        text = "\n\n".join(current_paragraphs).strip()
        if not text:
            return
        chunks.append(
            RawChunk(
                text=text,
                chapter_title=current_heading,
                page_start=min(current_pages),
                page_end=max(current_pages),
            )
        )

    for page in pages:
        # Paragraphs within a page are separated by blank lines. A heading frequently sits on its
        # own first line of a paragraph with NO blank line before the prose that follows it (these
        # books don't reliably insert one) -- so the heading check always looks at just the first
        # line, never the whole (possibly multi-line) paragraph, and whatever prose follows that
        # first line on the same paragraph still gets kept as real content under the new heading
        # rather than silently dropped.
        for para in re.split(r"\n\s*\n", page.text):
            para = para.strip()
            if not para:
                continue
            first_line, _, rest = para.partition("\n")
            heading = _looks_like_heading(first_line)
            if heading:
                # New section -- flush whatever was accumulated so far under the OLD heading,
                # then start fresh under the new one.
                flush()
                current_paragraphs = []
                current_pages = []
                current_heading = heading
                rest = rest.strip()
                if not rest:
                    continue
                para = rest

            current_word_count = sum(len(p.split()) for p in current_paragraphs)
            para_word_count = len(para.split())

            if current_word_count >= min_words and current_word_count + para_word_count > max_words:
                flush()
                current_paragraphs = []
                current_pages = []

            current_paragraphs.append(para)
            current_pages.append(page.page_number)

    flush()
    return chunks


# --- Reference-architecture ingestion (Part 2): HTML/Markdown sources, no page concept -----------
#
# Unlike the 5 PDF books, these documents (AWS/Azure/GCP's own published reference-architecture
# guides) come from the web with no real "page" -- headings are explicit and reliable (real <h1-6>
# tags, or real "#"/"##" Markdown syntax), so rather than reusing the PDF-oriented heading-guessing
# heuristic above, extraction normalizes every heading into a "# " (Markdown-style) prefixed line
# and chunk_plain_document splits on THAT explicit marker -- more reliable than regex-guessing
# because these sources actually mark their structure, unlike a PDF's plain text layer.

_MD_HEADING_RE = re.compile(r"^#{1,6}\s+(.+)$")
_MD_FRONTMATTER_RE = re.compile(r"\A---\n.*?\n---\n", re.DOTALL)
_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")  # [text](url) -> text
_MD_INLINE_CODE_RE = re.compile(r"`([^`]+)`")  # `code` -> code


def extract_markdown_text(markdown: str) -> str:
    """Strips YAML frontmatter and lightweight Markdown syntax (links, inline code) while keeping
    heading lines ('#'..'######') intact as the explicit chunk-boundary marker chunk_plain_document
    looks for. Deliberately does NOT strip '#' from headings themselves -- that's the signal."""
    text = _MD_FRONTMATTER_RE.sub("", markdown)
    text = _MD_LINK_RE.sub(r"\1", text)
    text = _MD_INLINE_CODE_RE.sub(r"\1", text)
    return text.strip()


# Elements that are never real article content on a docs/blog page -- navigation, ads, cookie
# banners, related-links rails, etc. Stripped before extracting text so none of this pollutes a
# chunk (verified against real fetches of learn.microsoft.com and cloud.google.com pages, both of
# which carry substantial nav/footer chrome around the actual article).
_HTML_NOISE_SELECTORS = (
    "nav",
    "header",
    "footer",
    "script",
    "style",
    "aside",
    "[role='navigation']",
    "[role='banner']",
    "[role='contentinfo']",
    ".breadcrumb",
    ".pageActions",
    ".feedback-section",
)


def extract_html_text(html: str) -> str:
    """Extracts the main article's text from a docs/blog page, normalizing <h1>-<h6> tags into
    '# '-prefixed marker lines (one '#' per heading level) so chunk_plain_document can find them
    the same way it finds Markdown headings -- both sources end up in the same normalized shape.
    Prefers a <article>/<main> element if present (real content, minimal chrome); falls back to
    <body> otherwise."""
    soup = BeautifulSoup(html, "html.parser")
    for selector in _HTML_NOISE_SELECTORS:
        for el in soup.select(selector):
            el.decompose()

    root = soup.find("article") or soup.find("main") or soup.body or soup
    lines: list[str] = []
    for el in root.find_all(["h1", "h2", "h3", "h4", "h5", "h6", "p", "li"]):
        text = el.get_text(" ", strip=True)
        if not text:
            continue
        if el.name and el.name[0] == "h" and el.name[1:].isdigit():
            level = int(el.name[1:])
            lines.append(f"\n{'#' * level} {text}\n")
        else:
            lines.append(text)
    return "\n\n".join(lines).strip()


def chunk_plain_document(
    text: str,
    min_words: int = MIN_CHUNK_WORDS,
    max_words: int = MAX_CHUNK_WORDS,
) -> list[RawChunk]:
    """Chunks a normalized plain-text document (headings marked as '#'-prefixed lines, from either
    extract_markdown_text or extract_html_text) into ~200-500 word chunks on heading boundaries --
    the web-source counterpart to chunk_book, minus PDF page tracking (page_start/page_end are
    always None; callers know these came from a URL, not a page number)."""
    chunks: list[RawChunk] = []
    current_paragraphs: list[str] = []
    current_heading: str | None = None

    def flush() -> None:
        if not current_paragraphs:
            return
        chunk_text = "\n\n".join(current_paragraphs).strip()
        if not chunk_text:
            return
        chunks.append(RawChunk(text=chunk_text, chapter_title=current_heading, page_start=None, page_end=None))

    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if not para:
            continue
        heading_match = _MD_HEADING_RE.match(para)
        if heading_match:
            flush()
            current_paragraphs = []
            current_heading = heading_match.group(1).strip()
            continue

        current_word_count = sum(len(p.split()) for p in current_paragraphs)
        para_word_count = len(para.split())
        if current_word_count >= min_words and current_word_count + para_word_count > max_words:
            flush()
            current_paragraphs = []
        current_paragraphs.append(para)

    flush()
    return _merge_degenerate_chunks(chunks)


# A trailing heading with barely any content under it (verified case: a doc's final "Related
# resources" section reduced to one bullet point, "- Architectural considerations for a
# multitenant solution") produces a chunk too short to carry real topical signal -- in practice
# such a short chunk's embedding scores anomalously high across UNRELATED queries (generic
# short phrases are less topically distinctive, not more), which is a worse outcome than just not
# having it as a separately-citable chunk at all. Web sources hit this more than PDF books (a
# genuine trailing links/references section is common on a docs page, rare mid-book).
_MIN_STANDALONE_CHUNK_WORDS = 25


def _merge_degenerate_chunks(chunks: list[RawChunk]) -> list[RawChunk]:
    if len(chunks) < 2:
        return chunks
    merged: list[RawChunk] = [chunks[0]]
    for chunk in chunks[1:]:
        if len(chunk.text.split()) < _MIN_STANDALONE_CHUNK_WORDS:
            prev = merged[-1]
            merged[-1] = RawChunk(
                text=f"{prev.text}\n\n{chunk.text}",
                chapter_title=prev.chapter_title,
                page_start=prev.page_start,
                page_end=chunk.page_end if chunk.page_end is not None else prev.page_end,
            )
        else:
            merged.append(chunk)
    return merged
