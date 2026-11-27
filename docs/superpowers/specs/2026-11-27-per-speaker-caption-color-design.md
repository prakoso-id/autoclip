# Per-Speaker Caption Color — Design Spec

**Date:** 2026-11-27
**Status:** Approved
**Scope:** Small feature (`captions.py`, `ClipPlayer.tsx`, `CaptionEditor.tsx`, `tests/test_captions.py`)

## 1. Intent & Why

In multi-speaker podcast clips (such as a 3-host couch setup), WhisperX diarization already labels each `Word.speaker` (`"SPEAKER_00"`, `"SPEAKER_01"`, etc.), and `GET /api/clips/{id}/words` already exposes `speaker` to the frontend. However, `captions.py` previously ignored `word.speaker`, rendering every speaker's highlighted word in the same preset accent colour and sometimes grouping words from two different speakers into a single caption line.

Coloring active words per speaker and breaking caption groups on speaker changes makes multi-speaker exchanges immediately legible on mobile screens.

## 2. Design

1. **Palette (`SPEAKER_PALETTE`):**
   - `("#FFE500", "#00E5FF", "#4ADE80", "#FF6B6B", "#C084FC", "#FB923C")` (Yellow, Cyan, Lime, Coral, Lavender, Orange).
   - `speaker_colour_map(words, default_accent)` maps distinct non-empty `word.speaker` values in order of first appearance in the clip:
     - When `<= 1` distinct speakers exist in `words`, returns `{}` so every word falls back to `style.accent` (100% backward-compatible for single-speaker and non-diarized clips).
     - When `>= 2` distinct speakers exist, Speaker 1 gets `SPEAKER_PALETTE[0]`, Speaker 2 gets `SPEAKER_PALETTE[1]`, etc. (wrapping modulo `len(SPEAKER_PALETTE)`).
2. **Speaker-Turn Group Break (`group_words`):**
   - Break the current `CaptionGroup` whenever `current[-1].speaker` and `word.speaker` are both non-empty and `word.speaker != current[-1].speaker`.
3. **ASS Rendering (`build_ass`):**
   - `_per_word_events` (`bold_pop`, `boxed`): uses the active word's speaker colour (from `speaker_colours.get(word.speaker)` falling back to `style.accent`).
   - `_karaoke_event` (`karaoke_fill`): when a multi-speaker map is active and the group has a speaker colour, prefixes `\2c` / `\1c` override so karaoke fill reflects the speaker.
4. **Frontend (`ClipPlayer.tsx` & `CaptionEditor.tsx`):**
   - `ClipPlayer.tsx`: mirrors `SPEAKER_PALETTE`, speaker colour mapping, and speaker-turn group breaking in `CaptionOverlay`.
   - `CaptionEditor.tsx`: when `>= 2` distinct speakers exist in `words`, displays a compact coloured speaker badge (`S1`, `S2`, `S3`) whenever the speaker changes in the word flow.
