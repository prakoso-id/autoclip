# Per-Speaker Caption Color Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Highlight active caption words with distinct per-speaker colours when diarization identifies 2+ speakers, break caption groups on speaker turns, and surface speaker colours in `ClipPlayer` and `CaptionEditor`.

**Architecture:** `captions.py` defines `SPEAKER_PALETTE` and `speaker_colour_map(words, default_accent)`, breaks groups on speaker transitions in `group_words`, and emits per-speaker inline ASS colour overrides in `_per_word_events` and `_karaoke_event`. `ClipPlayer.tsx` and `CaptionEditor.tsx` mirror the same palette and grouping rules.

**Tech Stack:** Python 3.11 (`pysubs2`), React + TypeScript + Tailwind CSS.

**Spec:** [2026-11-27-per-speaker-caption-color-design.md](file:///home/prakoso-dev/clipper-apps/autoclip/docs/superpowers/specs/2026-11-27-per-speaker-caption-color-design.md)

---

### Task 1: Backend Per-Speaker Grouping & ASS Colour Overrides

**Files:**
- Modify: `autoclip/backend/autoclip/pipeline/captions.py`
- Test: `autoclip/tests/test_captions.py`

- [ ] **Step 1:** Add failing tests in `autoclip/tests/test_captions.py` for speaker-turn group breaking, `speaker_colour_map` single-vs-multi-speaker behavior, and distinct ASS `\c` colour overrides per speaker in `build_ass`.
- [ ] **Step 2:** Run `.venv/bin/pytest tests/test_captions.py -v` and confirm failure.
- [ ] **Step 3:** Implement `SPEAKER_PALETTE`, `speaker_colour_map`, speaker-turn break in `group_words`, and speaker colour lookup in `build_ass` / `_per_word_events` / `_karaoke_event`.
- [ ] **Step 4:** Run `.venv/bin/pytest tests/test_captions.py -v` and confirm green.

### Task 2: Frontend `ClipPlayer` & `CaptionEditor` Speaker Colours

**Files:**
- Modify: `autoclip/frontend/src/components/ClipPlayer.tsx`
- Modify: `autoclip/frontend/src/components/CaptionEditor.tsx`

- [ ] **Step 1:** Update `ClipPlayer.tsx` (`groupWords` speaker-turn break + `speakerColorMap` active word accent in `CaptionOverlay`).
- [ ] **Step 2:** Update `CaptionEditor.tsx` to render compact coloured `S1`/`S2`/`S3` speaker badges at speaker transitions when 2+ speakers exist.
- [ ] **Step 3:** Run `npx tsc --noEmit && npm run build`, run full pytest + ruff, commit, push `origin local/pipeline`, and restart server.
