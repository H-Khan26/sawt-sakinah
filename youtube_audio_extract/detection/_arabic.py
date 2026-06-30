"""Arabic text normalization and the target-phrase registry.

Whisper emits Arabic script with inconsistent diacritics, hamza seating, and letter
forms across utterances/reciters. To match spoken phrases robustly we normalize both
the transcript and the canonical phrases to a diacritic-insensitive skeleton, then
fuzzy-match on that. Stdlib-only -- no heavy deps. See docs/audio/03-phrase-detection.md.
"""

from __future__ import annotations

from dataclasses import dataclass

# Combining harakat / tanwin / sukun / shadda (U+064B..U+0652) and the superscript
# alef (U+0670), plus the tatweel elongation (U+0640) carry no lexical content here.
_HARAKAT = dict.fromkeys(
    [*range(0x064B, 0x0653), 0x0670, 0x0640],
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


@dataclass(frozen=True)
class PhraseSpec:
    """A target phrase and how to recognise it.

    Attributes:
        type: Marker category ("takbir", "tasmi", "tahmid", "tasleem").
        label: Human-readable label emitted on the marker.
        canonical: Normalized canonical Arabic, used for whole-phrase fuzzy scoring.
        keywords: Normalized required tokens; a candidate window must contain a fuzzy
            match for each before it is scored (cheap, high-precision gate).
    """

    type: str
    label: str
    canonical: str
    keywords: tuple[str, ...]


def _spec(type: str, label: str, arabic: str, keywords: list[str]) -> PhraseSpec:
    return PhraseSpec(
        type=type,
        label=label,
        canonical=normalize_arabic(arabic),
        keywords=tuple(normalize_arabic(k) for k in keywords),
    )


# Order matters only for stable iteration; matching is independent per phrase.
PHRASE_REGISTRY: dict[str, PhraseSpec] = {
    "takbir": _spec("takbir", "Allahu Akbar", "الله أكبر", ["الله", "أكبر"]),
    "tasmi": _spec(
        "tasmi", "Sami' Allahu liman hamidah", "سمع الله لمن حمده", ["سمع", "حمده"]
    ),
    "tahmid": _spec(
        "tahmid", "Rabbana wa laka-l-hamd", "ربنا ولك الحمد", ["ربنا", "الحمد"]
    ),
    "tasleem": _spec(
        "tasleem", "As-salamu alaykum", "السلام عليكم", ["السلام", "عليكم"]
    ),
}
