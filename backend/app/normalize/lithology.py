"""DIN 4023 codes (BACKEND.md 7.8): validate a code and derive one from a printed description.

`valid_din_code` accepts only exact (case-sensitive) keys of assets/din4023_patterns/din_codes.json
("mG" medium gravel and "Mg" till marl differ; "Lö" and "Löl" contain "ö").

`din_code_from_text` reads the main component from multilingual nouns in data/din_vocabulary.yaml:
- DIN notation printed as such ("G, s, u'") gives its main code;
- nouns after a "with" word ("CLAY with sand", "Ton mit Steinen") are secondary;
- capitals mark the main component in mixed-case text (BS 5930: "gravelly SAND", "Firm brown CLAY");
- priority codes (fill, topsoil) win over the soil nouns describing them;
- size words next to the noun narrow sand, gravel and silt to a fraction ("fine SAND" -> fS,
  "sable fin" -> fS, "fine to coarse SAND" -> S);
- two different main components ("SAND and GRAVEL", "Sand, Kies") give None: there is no default
  lithology and no guess.
Adjectives (sandig, sandy, sableux ...) are not in the vocabulary, so "Sand, kiesig" and "gravelly SAND"
both give S.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache

from app.din import din_codes
from app.normalize.numbers import load_data, str_list


def valid_din_code(code: str | None) -> str | None:
    """`code` when it is a key of din_codes.json (case-sensitive), else None."""
    if code is None:
        return None
    key = unicodedata.normalize("NFC", code.strip())
    return key if key and key in din_codes() else None


@dataclass(frozen=True)
class _Lexicon:
    terms: dict[tuple[str, ...], str]
    max_words: int
    suffixes: tuple[tuple[str, str], ...]  # single-word terms, longest first (compound languages)


@dataclass(frozen=True)
class _Vocabulary:
    languages: dict[str, _Lexicon]
    union: _Lexicon
    base_of: dict[str, str]
    own_fraction: dict[str, str]
    fractions: dict[str, dict[str, str]]
    fraction_words: dict[str, str]
    range_words: frozenset[str]
    blockers: frozenset[str]
    with_words: frozenset[str]
    priority: tuple[str, ...]
    compound_languages: frozenset[str]
    compound_min_prefix: int
    notation_secondary: re.Pattern[str]


def _fold(text: str) -> str:
    return unicodedata.normalize("NFC", text).casefold()


def _words(text: str) -> tuple[str, ...]:
    return tuple(re.findall(r"[^\W\d_]+(?:['\u2019][^\W\d_]+)?", _fold(text)))


def _lexicon(terms: dict[tuple[str, ...], str]) -> _Lexicon:
    singles = sorted(
        ((w[0], c) for w, c in terms.items() if len(w) == 1 and len(w[0]) >= 3), key=lambda x: -len(x[0])
    )
    return _Lexicon(terms=terms, max_words=max((len(w) for w in terms), default=1), suffixes=tuple(singles))


@lru_cache(maxsize=1)
def _vocabulary() -> _Vocabulary:
    data = load_data("din_vocabulary.yaml")
    valid = din_codes()
    per_language: dict[str, dict[tuple[str, ...], str]] = {}
    for code, by_language in (data.get("terms") or {}).items():
        if str(code) not in valid:
            continue
        for language, terms in (by_language or {}).items():
            lexicon = per_language.setdefault(str(language), {})
            for term in str_list(terms):
                words = _words(term)
                if words:
                    lexicon[words] = str(code)

    fraction_words: dict[str, str] = {}
    for fraction, words in (data.get("fraction_words") or {}).items():
        for word in str_list(words):
            fraction_words[_fold(word)] = str(fraction)
    range_words = frozenset(_fold(w) for w in str_list(data.get("fraction_range_words")))
    blockers = frozenset(_fold(w) for w in str_list(data.get("fraction_blockers")))
    with_words = frozenset(_fold(w) for w in str_list(data.get("with_words")))

    # Terms used when the language is unknown: those that mean the same code in every language that
    # lists them, and that are not function words of any language ("till" is Swedish for "to").
    function_words = range_words | blockers | with_words | frozenset(fraction_words)
    union: dict[tuple[str, ...], str] = {}
    conflicts: set[tuple[str, ...]] = set()
    for lexicon in per_language.values():
        for words, code in lexicon.items():
            if words in union and union[words] != code:
                conflicts.add(words)
            union.setdefault(words, code)
    for words in conflicts | {w for w in union if len(w) == 1 and w[0] in function_words}:
        union.pop(words, None)

    fractions: dict[str, dict[str, str]] = {}
    base_of: dict[str, str] = {}
    own_fraction: dict[str, str] = {}
    for base, by_fraction in (data.get("fractions") or {}).items():
        fractions[str(base)] = {str(f): str(c) for f, c in (by_fraction or {}).items()}
        for fraction, code in fractions[str(base)].items():
            base_of[code] = str(base)
            own_fraction[code] = fraction
    return _Vocabulary(
        languages={language: _lexicon(terms) for language, terms in per_language.items()},
        union=_lexicon(union),
        base_of=base_of,
        own_fraction=own_fraction,
        fractions=fractions,
        fraction_words=fraction_words,
        range_words=range_words,
        blockers=blockers,
        with_words=with_words,
        priority=tuple(str(c) for c in str_list(data.get("priority_codes"))),
        compound_languages=frozenset(str_list(data.get("compound_languages"))),
        compound_min_prefix=int(data.get("compound_min_prefix", 3)),
        notation_secondary=re.compile(str(data.get("notation_secondary_pattern", r"^[a-z]{1,3}['*]?$"))),
    )


def vocabulary_codes() -> set[str]:
    """Every code the vocabulary can return (for tests)."""
    vocab = _vocabulary()
    codes = {c for lexicon in vocab.languages.values() for c in lexicon.terms.values()}
    return codes | {c for by_fraction in vocab.fractions.values() for c in by_fraction.values()}


def _language(language: str | None) -> str | None:
    if not language:
        return None
    primary = re.split(r"[-_]", language.strip().casefold())[0]
    return {"nb": "no", "nn": "no"}.get(primary, primary)


@dataclass(frozen=True)
class _Token:
    text: str
    folded: str
    word: bool


@dataclass(frozen=True)
class _Noun:
    start: int
    end: int  # inclusive token index
    code: str
    emphasised: bool
    secondary: bool


def _tokens(text: str) -> list[_Token]:
    found = re.findall(r"[^\W\d_]+(?:['\u2019][^\W\d_]+)?|[;.,/&+:()]", unicodedata.normalize("NFC", text))
    return [_Token(t, t.casefold(), t[0].isalpha()) for t in found]


def _notation(text: str) -> str | None:
    """The main code of a description printed as DIN notation ("G, s, u'"), else None."""
    parts = [p.strip() for p in re.split(r"[,;]", unicodedata.normalize("NFC", text))]
    if not parts or not parts[0]:
        return None
    main = valid_din_code(parts[0])
    if main is None:
        return None
    pattern = _vocabulary().notation_secondary
    if all(pattern.match(p) for p in parts[1:] if p):
        return main
    return None


def _fraction_sequence(tokens: list[_Token], indexes: range, *, joined: bool) -> set[str]:
    """Fractions named by the size words at `indexes`, read outwards from a noun while they are size
    words or range words between them ("fine to medium"). `joined`: a range word may come first because
    the noun itself names a fraction ("Fein- bis Mittelsand"). A size word followed by a density word
    ("medium dense") is not a size."""
    vocab = _vocabulary()
    fractions: set[str] = set()
    for i in indexes:
        token = tokens[i]
        if token.folded in vocab.fraction_words:
            following = tokens[i + 1].folded if i + 1 < len(tokens) else ""
            if following in vocab.blockers:
                break
            fractions.add(vocab.fraction_words[token.folded])
        elif token.folded in vocab.range_words and (fractions or joined):
            continue
        else:
            break
    return fractions


def _refine(noun: _Noun, tokens: list[_Token]) -> str:
    """Narrow or widen a sand/gravel/silt code by the size words printed next to it."""
    vocab = _vocabulary()
    base = vocab.base_of.get(noun.code, noun.code)
    if base not in vocab.fractions:
        return noun.code
    fractions: set[str] = set()
    if noun.code in vocab.own_fraction:
        fractions.add(vocab.own_fraction[noun.code])
    # size words before the noun, read backwards from it ("fine to medium SAND", "Fein- bis Mittelsand")
    own = bool(fractions)
    fractions |= _fraction_sequence(tokens, range(noun.start - 1, -1, -1), joined=own)
    # size words after the noun, possibly after one comma ("sable fin", "Sand, fine")
    after_start = noun.end + 1
    if after_start < len(tokens) and tokens[after_start].text == ",":
        after_start += 1
    fractions |= _fraction_sequence(tokens, range(after_start, len(tokens)), joined=False)
    if len(fractions) == 1:
        return vocab.fractions[base].get(next(iter(fractions)), base)
    if len(fractions) > 1:
        return base
    return noun.code


def _compound(word: str, lexicon: _Lexicon, min_prefix: int) -> str | None:
    for term, code in lexicon.suffixes:
        if word.endswith(term) and len(word) - len(term) >= min_prefix:
            return code
    return None


def _nouns(tokens: list[_Token], lexicon: _Lexicon, compound: bool, mixed_case: bool) -> list[_Noun]:
    vocab = _vocabulary()
    nouns: list[_Noun] = []
    secondary = False
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if not token.word:
            if token.text in ";.":
                secondary = False
            i += 1
            continue
        if token.folded in vocab.with_words:
            secondary = True
            i += 1
            continue
        match: tuple[int, str] | None = None
        for size in range(min(lexicon.max_words, len(tokens) - i), 0, -1):
            span = tokens[i : i + size]
            if not all(t.word for t in span):
                continue
            code = lexicon.terms.get(tuple(t.folded for t in span))
            if code is not None:
                match = (size, code)
                break
        if match is None and compound:
            code = _compound(token.folded, lexicon, vocab.compound_min_prefix)
            if code is not None:
                match = (1, code)
        if match is None:
            i += 1
            continue
        size, code = match
        span = tokens[i : i + size]
        emphasised = mixed_case and all(t.text.isupper() and len(t.text) >= 2 for t in span)
        nouns.append(_Noun(i, i + size - 1, code, emphasised, secondary))
        i += size
    return nouns


def din_code_from_text(description: str | None, language: str | None = None) -> str | None:
    """The DIN 4023 code of the description's main component, or None when it is not certain."""
    if description is None or not description.strip() or len(description) > 2000:
        return None
    notation = _notation(description)
    if notation is not None:
        return notation
    vocab = _vocabulary()
    lang = _language(language)
    lexicon = vocab.languages.get(lang) if lang else None
    compound = lexicon is not None and lang in vocab.compound_languages
    tokens = _tokens(description)
    mixed_case = any(ch.islower() for ch in description) and any(ch.isupper() for ch in description)
    nouns = _nouns(tokens, lexicon or vocab.union, compound, mixed_case)

    candidates = [n for n in nouns if not n.secondary]
    if not candidates:
        return None
    emphasised = [n for n in candidates if n.emphasised]
    if emphasised:
        candidates = emphasised
    priority = [n for n in candidates if n.code in vocab.priority]
    if priority:
        candidates = priority
    codes = {_refine(n, tokens) for n in candidates}
    bases = {vocab.base_of.get(c, c) for c in codes}
    if len(bases) != 1:
        return None
    code = codes.pop() if len(codes) == 1 else bases.pop()
    return valid_din_code(code)
