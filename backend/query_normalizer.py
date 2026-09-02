"""Query Normalizer: fast, local spell-correction for user-typed questions.

Sits between the request handlers and the LLM call:

    Chrome Extension -> FastAPI /explain(-stream)
                              |
                       Query Normalizer      <- this module
                              |
                     Retrieval / Page Context
                              |
                             LLM

Deliberately does NOT call an LLM to fix typos - that's slower and burns API
quota on something a local dictionary lookup does in microseconds. Uses
SymSpell (Symmetric Delete spelling correction), seeded with the standard
82k-word English frequency dictionary it ships with, plus a small TeaWhiz-
specific vocabulary (see CUSTOM_VOCABULARY below) so brand/product names
aren't mangled and typos *of* them can still be corrected.

Design rules (all load-bearing - see main.py's QUERY_NORMALIZER_MODE for how
these are enforced at the call site):
  - Never mutate the caller's original text. `normalize_query()` always
    returns both `original_query` and `normalized_query`; the caller decides
    whether to actually use the corrected one (see QUERY_NORMALIZER_MODE).
  - Don't correct words that are already valid/known - either a real English
    word or one of CUSTOM_VOCABULARY.
  - Only correct when confidence clears DEFAULT_CONFIDENCE_THRESHOLD - a
    wrong "correction" silently changes what the user asked, which is worse
    than leaving a typo alone (the LLM usually copes with a typo fine).

Context-aware correction (page content, conversation history influencing
what a word "should" be) is a deliberate non-goal here - it's the planned
next phase once shadow-mode logs show plain SymSpell correction is safe to
trust, at which point it'd extend `normalize_query()` rather than replace it.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from functools import lru_cache
from importlib import resources

from symspellpy import SymSpell, Verbosity

# Only apply a correction when we're at least this confident. Deliberately
# high (spec: >0.90) - a missed typo is recoverable, a wrong "correction"
# isn't.
DEFAULT_CONFIDENCE_THRESHOLD = 0.90

# SymSpell's own cap on how far it'll search for candidates. Distance-2
# candidates are already noisy (see _confidence below); going further would
# only add false positives.
MAX_EDIT_DISTANCE = 2

# Product/brand/tech terms that either (a) aren't in a general English
# dictionary at all (TeaWhiz, OpenAI, FastAPI, GPT), so a typo of them would
# otherwise resolve to an unrelated real word (e.g. "teawhz" -> "teach"), or
# (b) *are* in the dictionary but we want to guarantee they're never
# miscorrected away (Netflix, Readability, JavaScript). Frequency is set high
# enough to rank alongside genuinely common English words so SymSpell
# actually surfaces them as the top candidate for a nearby typo, instead of
# losing to an unrelated dictionary word at the same edit distance.
CUSTOM_VOCABULARY = {
    "teawhiz": "TeaWhiz",
    "netflix": "Netflix",
    "openai": "OpenAI",
    "fastapi": "FastAPI",
    "readability": "Readability",
    "gpt": "GPT",
    "javascript": "JavaScript",
}
CUSTOM_VOCABULARY_FREQUENCY = 10_000_000

# Common contractions typed without the apostrophe ("dont", "cant"). These
# are extremely common in casual typing (mobile keyboards autocorrect the
# apostrophe away constantly) but absent from the formal dictionary, so
# without this list they look exactly like typos of an unrelated, more
# "frequent" word - e.g. "dont" is edit-distance 1 from "done", which is a
# real, common word, and would otherwise clear the confidence threshold and
# silently flip a negation ("dont check this" -> "done check this"). Treated
# as already-known, same as CUSTOM_VOCABULARY - never a correction target.
NEVER_CORRECT = {
    "dont", "cant", "wont", "isnt", "arent", "wasnt", "werent", "hasnt",
    "havent", "hadnt", "doesnt", "didnt", "couldnt", "wouldnt", "shouldnt",
    "im", "ive", "youre", "theyre", "weve", "youve", "theyve",
    "id", "youd", "hed", "shed", "theyd", "whats", "thats", "lets",
    "wheres", "hows", "whos", "shes", "hes",
}

# Below this length, edit-distance-1 candidates are too ambiguous to trust:
# most short strings are one edit from *several* equally common real words
# (e.g. "gtp" is 1 edit from "ftp", "gap", "gpt", and "gtd" all at once, with
# generic word frequency easily outweighing our CUSTOM_VOCABULARY boost).
# Excluding them means a typo of a 3-letter CUSTOM_VOCABULARY term like "gpt"
# won't be corrected either - an accepted tradeoff, since guessing wrong here
# has no reliable signal to guard against without page/conversation context
# (the deferred context-aware phase).
MIN_CORRECTABLE_LENGTH = 4

# QWERTY adjacency, used only as a confidence nudge for single-substitution
# typos (e.g. "cehck" via an 'h'/'j' slip) - real typos cluster on adjacent
# keys far more than a same-edit-distance random substitution would.
_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"]
_ADJACENT: dict[str, set[str]] = {}
for _row_i, _row in enumerate(_ROWS):
    for _i, _ch in enumerate(_row):
        neighbors: set[str] = set()
        if _i > 0:
            neighbors.add(_row[_i - 1])
        if _i < len(_row) - 1:
            neighbors.add(_row[_i + 1])
        for _other_row in (_ROWS[_row_i - 1] if _row_i > 0 else "", _ROWS[_row_i + 1] if _row_i < len(_ROWS) - 1 else ""):
            if _other_row and _i < len(_other_row):
                neighbors.add(_other_row[_i])
        _ADJACENT[_ch] = neighbors


def _keyboard_adjacent(a: str, b: str) -> bool:
    return b in _ADJACENT.get(a, ())


# A token is a run of letters, optionally with internal apostrophes ("don't",
# "netflix's"). Everything else (whitespace, punctuation, digits) is captured
# by the surrounding non-matches, untouched, so the original spacing and
# punctuation can be reproduced exactly in normalized_query.
_WORD_RE = re.compile(r"([A-Za-z]+(?:'[A-Za-z]+)*)")


@dataclass
class Correction:
    original_word: str
    corrected_word: str
    confidence: float
    edit_distance: int


@dataclass
class NormalizationResult:
    original_query: str
    normalized_query: str
    corrections: list[Correction] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.corrections)


@lru_cache(maxsize=1)
def _get_sym_spell() -> SymSpell:
    """Builds the SymSpell instance once per process - loading the 82k-word
    dictionary takes real time (tens of ms), so this must not run per-request."""
    sym_spell = SymSpell(max_dictionary_edit_distance=MAX_EDIT_DISTANCE, prefix_length=7)
    dictionary_path = str(
        resources.files("symspellpy").joinpath("frequency_dictionary_en_82_765.txt")
    )
    sym_spell.load_dictionary(dictionary_path, term_index=0, count_index=1)

    for term in CUSTOM_VOCABULARY:
        sym_spell.create_dictionary_entry(term, CUSTOM_VOCABULARY_FREQUENCY)

    return sym_spell


def _restore_case(original: str, corrected_lower: str) -> str:
    """Applies `original`'s casing pattern to the corrected word - except for
    a CUSTOM_VOCABULARY hit, which always uses its canonical brand casing
    ("netflx" -> "Netflix", never "netflix" or "NETFLIX")."""
    if corrected_lower in CUSTOM_VOCABULARY:
        return CUSTOM_VOCABULARY[corrected_lower]
    if original.isupper():
        return corrected_lower.upper()
    if original[:1].isupper():
        return corrected_lower.capitalize()
    return corrected_lower


def _confidence(distance: int, frequency: int, original_lower: str, corrected_lower: str) -> float:
    """Heuristic confidence in [0, 1], combining SymSpell's edit distance and
    candidate frequency with a keyboard-proximity bonus. SymSpell itself has
    no notion of "confidence" - this is what turns its raw candidate list
    into the >0.90-threshold gate the correction rule requires.
    """
    if distance <= 0:
        return 1.0

    # Real typos are overwhelmingly a single edit; two-edit "corrections" are
    # far more likely to be a coincidentally-close but unrelated word.
    base = 0.95 if distance == 1 else 0.65

    # Log-scaled so common words like "the" (~2*10^10) and merely-common
    # words like "readability" (~10^6) both land close to 1.0, while rare
    # dictionary entries pull the score down.
    freq_component = min(1.0, math.log10(frequency + 10) / 7.5)

    confidence = 0.55 * base + 0.45 * freq_component

    if distance == 1 and len(original_lower) == len(corrected_lower):
        diffs = [(a, b) for a, b in zip(original_lower, corrected_lower) if a != b]
        if len(diffs) == 1 and _keyboard_adjacent(*diffs[0]):
            confidence += 0.05

    return round(min(confidence, 0.99), 4)


def _correct_word(word: str, threshold: float) -> tuple[str, Correction | None]:
    lower = word.lower()
    sym_spell = _get_sym_spell()

    # Rule: never touch words that are already known - either a real English
    # word, one of our own product terms, or a common apostrophe-dropped
    # contraction. This is what stops the normalizer from "fixing"
    # correctly-spelled (or at least already-understood) input.
    if lower in sym_spell.words or lower in NEVER_CORRECT:
        return word, None

    # Short tokens ("a", "ok", "hi", "gtp", ...) are too ambiguous for
    # edit-distance correction to be reliable - see MIN_CORRECTABLE_LENGTH.
    if len(lower) < MIN_CORRECTABLE_LENGTH:
        return word, None

    suggestions = sym_spell.lookup(lower, Verbosity.CLOSEST, max_edit_distance=MAX_EDIT_DISTANCE)
    if not suggestions:
        # No candidate within edit distance 2 - could be a proper noun, a
        # foreign word, or something genuinely unrecognizable. Guessing here
        # would violate "never destroy the user's input", so leave it alone.
        return word, None

    # Verbosity.CLOSEST returns every candidate at the single smallest edit
    # distance found, sorted by frequency - which means a generic
    # high-frequency word ("net", "metal") can out-rank a CUSTOM_VOCABULARY
    # term ("netflix") at that same distance purely on raw word frequency,
    # even though the vocab term is the one we actually trust (e.g. "netfl"
    # -> "netflix" needs this; plain frequency alone picks "net"/"metal"
    # instead). Prefer a same-distance vocab match over the frequency winner.
    vocab_match = next((s for s in suggestions if s.term in CUSTOM_VOCABULARY), None)
    best = vocab_match or suggestions[0]

    if best.term in CUSTOM_VOCABULARY:
        # Small, curated, hand-picked list - much lower false-positive risk
        # than an arbitrary dictionary match, so it's trusted further out
        # than the general edit-distance-based formula below would allow.
        # Distance is capped at MAX_EDIT_DISTANCE (2) by the lookup above.
        confidence = 0.98 if best.distance <= 1 else 0.92
    else:
        confidence = _confidence(best.distance, best.count, lower, best.term)

    if confidence < threshold or best.term == lower:
        return word, None

    corrected = _restore_case(word, best.term)
    return corrected, Correction(
        original_word=word,
        corrected_word=corrected,
        confidence=confidence,
        edit_distance=best.distance,
    )


def normalize_query(query: str, threshold: float = DEFAULT_CONFIDENCE_THRESHOLD) -> NormalizationResult:
    """Spell-corrects `query` word by word using local SymSpell lookups.

    Always returns both the original and a normalized version - the caller
    (see QUERY_NORMALIZER_MODE in main.py) decides whether to actually send
    the normalized one to the LLM, or just log/compare it in shadow mode.
    """
    if not query or not query.strip():
        return NormalizationResult(original_query=query, normalized_query=query)

    parts = _WORD_RE.split(query)
    corrections: list[Correction] = []

    for i, part in enumerate(parts):
        # re.split with one capturing group alternates: even indices are the
        # untouched separators (whitespace/punctuation/digits), odd indices
        # are word tokens. Apostrophe'd tokens (contractions, possessives)
        # are left alone entirely - not worth the risk of mangling "don't".
        if i % 2 == 0 or "'" in part:
            continue
        corrected, correction = _correct_word(part, threshold)
        if correction:
            parts[i] = corrected
            corrections.append(correction)

    normalized_query = "".join(parts)
    return NormalizationResult(
        original_query=query,
        normalized_query=normalized_query,
        corrections=corrections,
    )
