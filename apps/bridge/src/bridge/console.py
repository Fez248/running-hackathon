"""Encoding-safe console output.

A rejected capture must print its verdict. On Windows the console encoding is
still cp1252, which cannot represent ``>=``-as-``\u2265`` or the arrows and
symbols the quality gate's messages are written with, so ``print()`` raised
``UnicodeEncodeError`` and the one path that must never fail printed a traceback
instead of the reason the recording was refused.

Rather than restrict every message to ASCII forever, output goes through
:func:`echo`: it keeps the typographic form wherever the terminal can show it
and falls back to a readable ASCII transliteration where it cannot.
"""

from __future__ import annotations

import sys
import unicodedata
from typing import TextIO

# Transliterations, not deletions: a verdict that says "sampled below >=100 Hz"
# is still the verdict, where one with the comparison silently dropped is not.
ASCII_FALLBACKS = {
    "\u2265": ">=",
    "\u2264": "<=",
    "\u2273": ">~",
    "\u2272": "<~",
    "\u2248": "~",
    "\u00b1": "+/-",
    "\u00b2": "2",
    "\u00b3": "3",
    "\u00b7": "*",
    "\u00d7": "x",
    "\u2014": "--",
    "\u2013": "-",
    "\u2192": "->",
    "\u2190": "<-",
    "\u201c": '"',
    "\u201d": '"',
    "\u2018": "'",
    "\u2019": "'",
    "\u2026": "...",
    "\u00a7": "S",
    "\u00b0": " deg",
    "\u26a0": "!",
    "\ufe0f": "",
}
_TABLE = str.maketrans(ASCII_FALLBACKS)


def ascii_fallback(text: str) -> str:
    """``"\u2265100 Hz"`` -> ``">=100 Hz"``; anything left over is dropped as an accent."""
    translated = text.translate(_TABLE)
    # NFKD then a strict ASCII pass turns é into e and drops what has no ASCII
    # form at all, which is better than a stream of question marks.
    decomposed = unicodedata.normalize("NFKD", translated)
    return decomposed.encode("ascii", "ignore").decode("ascii")


def encodable(text: str, stream: TextIO) -> bool:
    encoding = getattr(stream, "encoding", None) or "utf-8"
    try:
        text.encode(encoding)
    except (UnicodeEncodeError, LookupError):
        return False
    return True


def safe_text(text: str, stream: TextIO | None = None) -> str:
    """``text`` as the stream can actually represent it."""
    stream = stream or sys.stdout
    return text if encodable(text, stream) else ascii_fallback(text)


def echo(*parts: object, stream: TextIO | None = None, flush: bool = False) -> None:
    """``print`` that cannot fail on the encoding of the terminal it prints to."""
    stream = stream or sys.stdout
    text = " ".join(str(part) for part in parts)
    try:
        print(safe_text(text, stream), file=stream, flush=flush)
    except UnicodeEncodeError:
        # The encoding lied about what it accepts (or the fallback still holds
        # something it cannot take). Printing the verdict badly beats crashing.
        print(text.encode("ascii", "backslashreplace").decode("ascii"), file=stream, flush=flush)
