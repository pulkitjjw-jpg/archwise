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
    page_start: int
    page_end: int


def extract_pages(pdf_path: str) -> list[PageText]:
    """Extracts cleaned text per page. 1-indexed page numbers (matches what a reader would cite,
    not pdfplumber's 0-indexed page list)."""
    pages: list[PageText] = []
    with pdfplumber.open(pdf_path) as pdf:
        for idx, page in enumerate(pdf.pages):
            raw = page.extract_text(x_tolerance=PDF_X_TOLERANCE) or ""
            pages.append(PageText(page_number=idx + 1, text=_clean_text(raw)))
    return pages


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
    # ordinary short sentence fragment that happens to lack terminal punctuation.
    m = _PLAIN_HEADING_RE.match(line)
    if m:
        words = line.split()
        if len(words) >= 2:
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
