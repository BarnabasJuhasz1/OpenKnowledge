"""Local, dependency-free keyword extraction (RAKE-style).

The free/offline fallback used when no LLM API key is configured or the LLM call
fails. Good enough to seed a keyword search from a short description.
"""
from __future__ import annotations

import re

from .base import KeywordGenerator, KeywordResult

_STOPWORDS = {
    "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "for", "with",
    "about", "as", "at", "by", "from", "into", "over", "after", "is", "are",
    "be", "been", "being", "this", "that", "these", "those", "it", "its",
    "i", "you", "we", "they", "he", "she", "want", "like", "know", "learn",
    "research", "researching", "study", "studying", "understand", "find",
    "looking", "look", "interested", "topic", "topics", "paper", "papers",
    "would", "could", "should", "can", "will", "my", "me", "more", "some",
    "how", "what", "which", "their", "regarding", "related", "using",
    "use", "used", "based", "techniques", "technique", "methods", "method",
}
_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9\-]+")
_SPLIT_RE = re.compile(r"[^A-Za-z0-9\-]+")


def _candidate_phrases(text: str) -> list[str]:
    """Split text into candidate phrases at stopwords / punctuation."""
    phrases: list[str] = []
    current: list[str] = []
    for token in _SPLIT_RE.split(text.lower()):
        if not token:
            continue
        if token in _STOPWORDS or len(token) < 2:
            if current:
                phrases.append(" ".join(current))
                current = []
        else:
            current.append(token)
    if current:
        phrases.append(" ".join(current))
    return phrases


def extract_keywords(text: str, limit: int = 10) -> list[str]:
    phrases = _candidate_phrases(text)
    if not phrases:
        return []

    # Word frequencies across the text drive phrase scoring (RAKE degree-ish).
    freq: dict[str, int] = {}
    for phrase in phrases:
        for word in phrase.split():
            freq[word] = freq.get(word, 0) + 1

    scored: list[tuple[float, str]] = []
    seen: set[str] = set()
    for phrase in phrases:
        if phrase in seen:
            continue
        seen.add(phrase)
        words = phrase.split()
        # Favour multi-word phrases and frequent words; cap phrase length.
        if len(words) > 4:
            words = words[:4]
            phrase = " ".join(words)
        score = sum(freq.get(w, 1) for w in words) * len(words)
        scored.append((score, phrase))

    scored.sort(key=lambda s: s[0], reverse=True)
    return [p for _, p in scored[:limit]]


class HeuristicKeywordGenerator(KeywordGenerator):
    async def generate(self, prompt: str, bib_context: str = "") -> KeywordResult:
        keywords = extract_keywords(prompt, limit=10)

        # Merge in explicit keyword terms found in the bib context.
        if bib_context:
            for line in bib_context.splitlines():
                if "Keywords:" in line:
                    segment = line.split("Keywords:", 1)[1].split("|", 1)[0]
                    for kw in re.split(r"[;,]", segment):
                        kw = kw.strip()
                        if kw and kw.lower() not in {k.lower() for k in keywords}:
                            keywords.append(kw)

        # De-dupe, keep order, cap.
        seen: set[str] = set()
        deduped: list[str] = []
        for kw in keywords:
            low = kw.lower()
            if low not in seen:
                seen.add(low)
                deduped.append(kw)
        return KeywordResult(keywords=deduped[:12], method="heuristic", model=None)
