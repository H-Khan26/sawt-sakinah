"""The Quran text as a flat, normalized word list with a three-word-sequence index.

Loads the vendored Tanzil "Simple Clean" text (Hafs, ``assets/quran-simple-clean.txt``,
one ``surah|ayah|text`` line per ayah) and the surah metadata
(``assets/quran-surahs.json``) once, on first use. Every ayah is normalized with
``_arabic.arabic_words`` -- the same routine the transcript goes through -- and laid out
as one list of about 77,800 words, each tagged with its surah and ayah. Every
three-word sequence is indexed to the positions where it starts, which is what the
surah matcher anchors on. Pure and deterministic; the only I/O is reading the two assets.
See docs/audio/03-surah-recognition.md.
"""

from __future__ import annotations

import json
import threading
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from ._arabic import arabic_words

_ASSETS = Path(__file__).with_name("assets")
TEXT_PATH = _ASSETS / "quran-simple-clean.txt"
SURAHS_PATH = _ASSETS / "quran-surahs.json"

#: Credit line Tanzil's terms ask for wherever the text is used.
CREDIT = (
    "Quran text: Tanzil Project (tanzil.net), Simple Clean, Hafs. Used verbatim under its terms."
)

#: The basmala as the matcher sees it (normalized words).
BASMALA = tuple(arabic_words("بسم الله الرحمن الرحيم"))

Trigram = tuple[str, str, str]


@dataclass(frozen=True)
class Surah:
    """One surah's metadata (from Tanzil's quran-data)."""

    number: int
    name: str  # Arabic name
    tname: str  # transliteration, e.g. "Al-Faatiha"
    ename: str  # English meaning
    ayas: int  # ayah count
    type: str  # "Meccan" | "Medinan"


@dataclass(frozen=True)
class QuranIndex:
    """The normalized Quran as parallel per-word arrays plus lookup tables.

    Attributes:
        words: Normalized words in mushaf order.
        surah: Surah number of each word.
        ayah: Ayah number of each word.
        surah_end: For each surah number, the index one past its last word.
        trigrams: Each three-word sequence mapped to the word indexes where it starts.
            A sequence never crosses a surah boundary.
        surahs: Metadata by surah number (index 0 is unused).
    """

    words: list[str]
    surah: array
    ayah: array
    surah_end: list[int]
    trigrams: dict[Trigram, list[int]]
    surahs: tuple[Optional[Surah], ...]

    def positions(self, trigram: Trigram) -> list[int]:
        return self.trigrams.get(trigram, [])


_LOCK = threading.Lock()
_INDEX: Optional[QuranIndex] = None


def _read_surahs() -> tuple[Optional[Surah], ...]:
    entries = json.loads(SURAHS_PATH.read_text(encoding="utf-8"))
    table: list[Optional[Surah]] = [None] * 115
    for e in entries:
        table[int(e["number"])] = Surah(
            number=int(e["number"]),
            name=e["name"],
            tname=e["tname"],
            ename=e["ename"],
            ayas=int(e["ayas"]),
            type=e["type"],
        )
    return tuple(table)


def _build() -> QuranIndex:
    words: list[str] = []
    surah = array("H")
    ayah = array("H")
    surah_end = [0] * 115
    with TEXT_PATH.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            s, a, text = line.split("|", 2)
            n_s, n_a = int(s), int(a)
            ayah_words = arabic_words(text)
            # The text heads ayah 1 of every surah but 1 and 9 with the basmala, which in
            # Hafs is not part of the ayah; the matcher handles a recited basmala itself.
            if n_a == 1 and n_s != 1 and tuple(ayah_words[: len(BASMALA)]) == BASMALA:
                ayah_words = ayah_words[len(BASMALA) :]
            for w in ayah_words:
                words.append(w)
                surah.append(n_s)
                ayah.append(n_a)
            surah_end[n_s] = len(words)
    trigrams: dict[Trigram, list[int]] = {}
    for i in range(len(words) - 2):
        if surah[i] != surah[i + 2]:
            continue
        trigrams.setdefault((words[i], words[i + 1], words[i + 2]), []).append(i)
    return QuranIndex(
        words=words,
        surah=surah,
        ayah=ayah,
        surah_end=surah_end,
        trigrams=trigrams,
        surahs=_read_surahs(),
    )


def load() -> QuranIndex:
    """The process-wide index, built on first call (a fraction of a second)."""
    global _INDEX
    with _LOCK:
        if _INDEX is None:
            _INDEX = _build()
        return _INDEX


def surahs() -> list[Surah]:
    """All 114 surahs in order."""
    return [s for s in load().surahs if s is not None]


def surah(number: int) -> Surah:
    """Metadata for surah ``number`` (1..114); raises ``KeyError`` otherwise."""
    table = load().surahs
    if not 1 <= number < len(table) or table[number] is None:
        raise KeyError(number)
    return table[number]


__all__ = ["BASMALA", "CREDIT", "QuranIndex", "Surah", "load", "surah", "surahs"]
