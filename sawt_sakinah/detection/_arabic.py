"""Arabic text normalization shared by the transcript and the Quran text.

Whisper emits Arabic script with inconsistent diacritics, hamza seating and letter forms,
and the Quran text uses its own spelling conventions. To compare the two we reduce both
to a diacritic-insensitive skeleton of bare letters, then fuzzy-match on that.
Stdlib-only -- no heavy deps. See docs/audio/03-surah-recognition.md.
"""

from __future__ import annotations

import re

# Combining harakat / tanwin / sukun / shadda (U+064B..U+0652), the combining madda,
# hamza and other marks (U+0653..U+065F), the superscript alef (U+0670) and the tatweel
# elongation (U+0640) carry no lexical content here. Stripping a combining hamza leaves
# its bare carrier, as the letter-form folds below do for the precomposed forms.
_HARAKAT = dict.fromkeys(
    [*range(0x064B, 0x0660), 0x0670, 0x0640],
    None,
)

# Letter-form unifications: alef variants -> bare alef, alef maqsura -> ya,
# ta marbuta -> ha, and the standalone hamza forms -> bare alef / dropped.
_LETTER_MAP = {
    "أ": "ا",  # alef with hamza above
    "إ": "ا",  # alef with hamza below
    "آ": "ا",  # alef with madda
    "ٱ": "ا",  # alef wasla
    "ى": "ي",  # alef maqsura -> ya
    "ة": "ه",  # ta marbuta -> ha
    "ؤ": "و",  # waw with hamza -> waw
    "ئ": "ي",  # ya with hamza -> ya
    "ء": "",        # standalone hamza -> dropped
}

# Anything that is not a base Arabic letter (Quranic annotation marks, punctuation,
# digits, Latin text) once the forms above are folded.
_NON_LETTERS = re.compile(r"[^ء-غف-ي]+")


def normalize_arabic(text: str) -> str:
    """Return a diacritic-insensitive, form-normalized skeleton of ``text``.

    Strips harakat/tatweel, unifies alef/hamza/ta-marbuta/alef-maqsura forms, and
    collapses runs of whitespace. Non-Arabic characters are left as-is so that the
    same routine is safe to apply to transliterated input.
    """
    text = text.translate(_HARAKAT)
    out = []
    for ch in text:
        out.append(_LETTER_MAP.get(ch, ch))
    return " ".join("".join(out).split())


def arabic_words(text: str) -> list[str]:
    """Split ``text`` into normalized words of bare Arabic letters.

    Runs :func:`normalize_arabic`, then treats every non-letter (punctuation, Quranic
    marks, digits) as a separator, so ``"الرَّحِيمِ ۝"`` gives ``["الرحيم"]``.
    """
    return _NON_LETTERS.sub(" ", normalize_arabic(text)).split()
