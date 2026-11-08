import re

_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_BULLET_RE = re.compile(r"^\s*[-*]\s+")


def _split_units(lines: list[str]) -> list[str]:
    """
    Turn the body lines of one section into 'units' that are never split.

    Convention used by our knowledge base files: ONE FACT PER LINE. So every
    non-blank line (bullet or plain) is its own unit. A line that starts with
    whitespace is treated as a continuation of the previous line, which lets
    you hard-wrap a long fact if you ever need to.
    """
    units: list[str] = []
    current: list[str] = []

    def flush() -> None:
        nonlocal current
        if current:
            units.append(" ".join(part.strip() for part in current))
        current = []

    for raw in lines:
        if not raw.strip():
            flush()
        elif current and raw[:1].isspace() and not _BULLET_RE.match(raw):
            current.append(raw)  # continuation of the previous line
        else:
            flush()
            current = [_BULLET_RE.sub("- ", raw, count=1)]
    flush()
    return units


def chunk_markdown(text: str, chunk_size: int = 700) -> list[dict]:
    """
    Split a markdown knowledge base into self-contained chunks.

    - Chunks never cross a '#', '##' or '###' heading.
    - Every chunk starts with its heading path, e.g.
      "Chandigarh Cafe and Restaurant | Menu — Beverages | Mocktails",
      so a chunk such as a list of prices still says what it is about.
    - Bullets and lines are atomic: a dish and its price are never separated.
    - chunk_size is a soft limit in characters (heading path included).

    Returns a list of {"text": str, "section": str}.
    """
    text = _COMMENT_RE.sub("", text)

    title = h2 = h3 = None
    body: list[str] = []
    chunks: list[dict] = []

    def flush_section() -> None:
        nonlocal body
        units = _split_units(body)
        body = []
        if not units:
            return
        section = " | ".join(p for p in (title, h2, h3) if p)
        current: list[str] = []
        size = len(section)
        for unit in units:
            if current and size + 1 + len(unit) > chunk_size:
                chunks.append({"text": section + "\n" + "\n".join(current), "section": section})
                current, size = [], len(section)
            current.append(unit)
            size += 1 + len(unit)
        if current:
            chunks.append({"text": section + "\n" + "\n".join(current), "section": section})

    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("### "):
            flush_section()
            h3 = stripped[4:].strip()
        elif stripped.startswith("## "):
            flush_section()
            h2, h3 = stripped[3:].strip(), None
        elif stripped.startswith("# "):
            flush_section()
            title = re.sub(r"\s*[—-]\s*Knowledge Base\s*$", "", stripped[2:].strip())
            h2, h3 = None, None
        else:
            body.append(line)
    flush_section()
    return chunks


def chunk_text(text: str, chunk_size: int = 700, chunk_overlap: int = 0) -> list[str]:
    """Backwards-compatible wrapper: returns only the chunk texts (overlap is no longer needed)."""
    return [c["text"] for c in chunk_markdown(text, chunk_size)]