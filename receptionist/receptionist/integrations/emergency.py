# receptionist/integrations/emergency.py
"""Deterministic emergency-symptom detection on caller transcripts.

This is a safety net that runs on every final caller transcript, independent
of the LLM. A match marks the call urgent (so staff see it on the dashboard)
and the LLM is separately instructed by the system prompt to advise 112.
It never diagnoses; it only flags.
"""
from __future__ import annotations

import re

# Lower-case phrases. English plus common Hindi / Bengali (native script and
# romanised) ways people describe red-flag symptoms on the phone.
EMERGENCY_PHRASES: tuple[str, ...] = (
    # English
    "chest pain", "pain in my chest", "pain in the chest", "heart attack",
    "can't breathe", "cant breathe", "can't breath", "cannot breathe", "can not breathe", "not breathing",
    "difficulty breathing", "trouble breathing", "breathless", "short of breath",
    "shortness of breath", "unconscious", "fainted", "passed out", "not responding",
    "seizure", "fits", "convulsion", "stroke", "face drooping", "slurred speech",
    "heavy bleeding", "bleeding a lot", "won't stop bleeding", "severe bleeding",
    "poison", "overdose", "swallowed", "suicide", "kill myself", "self harm",
    "severe burn", "snake bite", "accident", "head injury", "choking",
    "severe allergic", "anaphylaxis", "throat swelling",
    # Hindi (romanised + Devanagari)
    "seene mein dard", "seene me dard", "chhati mein dard", "saans nahi",
    "saans lene mein", "behosh", "khoon beh", "दिल का दौरा", "सीने में दर्द",
    "छाती में दर्द", "सांस नहीं", "बेहोश", "खून बह",
    # Bengali (romanised + Bengali script)
    "buke byatha", "buke batha", "shash nite parchhi na", "ogyan", "ojnan",
    "বুকে ব্যথা", "শ্বাস নিতে", "অজ্ঞান", "রক্ত পড়ছে",
)

_NORMALISE = re.compile(r"[^\w\sऀ-ॿঀ-৿']+")


def detect_emergency(text: str | None) -> list[str]:
    """Return the emergency phrases found in `text` (empty list if none)."""
    if not text:
        return []
    norm = " " + " ".join(_NORMALISE.sub(" ", text.lower()).split()) + " "
    found: list[str] = []
    for phrase in EMERGENCY_PHRASES:
        p = " ".join(_NORMALISE.sub(" ", phrase.lower()).split())
        # Latin phrases match on word boundaries; Indic scripts as substrings.
        if (f" {p} " in norm) if p.isascii() else (p in norm):
            found.append(phrase)
    return found
