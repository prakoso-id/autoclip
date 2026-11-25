# Outro CTA Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an auto-generated, live-blurred YouTube Bridge CTA overlay that fades in atop the final seconds of exported clips (zero added duration) with WYSIWYG previews in Settings and Review.

**Architecture:** `OutroSettings` lives under `ExportSettings` in `config.py`. A new `pipeline/outro.py` module renders a ratio-aware transparent RGBA PNG CTA card (dark gradient scrim + YouTube badge + CTA headline + optional YouTube title + channel & optional social handles) using Pillow and bundled `Anton`/`Inter` fonts. `pipeline/export.py` trims only the final `eff_outro_s` seconds of the uncaptioned reframed video, applies `boxblur=20:2`, overlays the PNG, fades alpha `0 -> 1` over `0.35s`, and composites it topmost onto the captioned stream so duration and audio are unchanged.

**Tech Stack:** Python 3.11+, FastAPI, Pydantic v2, Pillow (`PIL`), FFmpeg (`filter_complex`), React + TypeScript + Tailwind CSS (Vite).

**Spec:** [2026-11-25-outro-cta-overlay-design.md](file:///home/prakoso-dev/clipper-apps/autoclip/docs/superpowers/specs/2026-11-25-outro-cta-overlay-design.md)

## Global Constraints

- Python `>=3.11,<3.13`; run tests from `autoclip/` via `.venv/bin/pytest`.
- Declare `pillow>=10.0` explicitly in `autoclip/pyproject.toml`.
- Zero added clip duration: exported video length equals `request.duration_s`; audio stream (`loudnorm`) is untouched.
- Only blur the final `eff_outro_s` seconds of video (never run `boxblur` on the full clip).
- Effective outro duration is `min(outro.duration_s, clip_duration_s * 0.4)`; if `< 0.5s`, skip the outro cleanly.
- Fade-in duration is `0.35s` (clamped to `min(0.35, eff_outro_s * 0.4)`).
- Frontend production bundle must be rebuilt (`npm run build` in `autoclip/frontend`) so `backend/autoclip/static/` serves the updated UI.
- Preserve existing API & config backward compatibility (`enabled: False` by default; legacy `config.json` without `export.outro` loads cleanly).

## Review Focus

1. **Short-clip clamping & skip threshold:** A 3.0s outro on a 5.0s clip clamps to `2.0s`; on a 1.0s clip (`0.4s < 0.5s`), the outro is skipped cleanly without generating an invalid FFmpeg filtergraph.
2. **Long/Unicode titles & missing handles:** A 140-char title wraps to max 2 lines with `…` without overflowing canvas width; empty `youtube_handle` + `source_channel=None` and empty IG/TikTok handles omit those rows cleanly without blank gaps or crashes.
3. **Nested partial `PUT /api/settings` merges:** Updating `{"export": {"outro": {"enabled": true}}}` preserves sibling `export.outro` fields (`cta_text`, `youtube_handle`, `duration_s`) AND sibling `export` fields (`ratio`, `loudness_lufs`); legacy `config.json` lacking `export.outro` loads defaults.
4. **Real FFmpeg render parity & pixel change:** Rendering with outro (both single-segment and multi-segment crop paths, with and without captions, and with awkward path characters) produces exact `duration_s`, `yuv420p`, leaves early frames identical to non-outro renders, and visibly alters the tail frame.
5. **Per-clip `include_outro` API override:** `POST /api/clips/{id}/export` with `include_outro=False` disables outro when globally enabled, `include_outro=True` enables outro when globally disabled, and `include_outro=None` inherits `settings.export.outro.enabled`.

---

### Task 1: Outro Settings Model & Config Persistence

**Files:**
- Modify: `autoclip/pyproject.toml` (add `"pillow>=10.0"` to `dependencies`)
- Modify: `autoclip/backend/autoclip/config.py:85-96`
- Test: `autoclip/tests/test_config.py`

**Interfaces:**
- Produces:
  - `autoclip.config.OutroSettings(BaseModel)` with fields:
    - `enabled: bool = False`
    - `duration_s: float = Field(default=3.0, ge=1.0, le=8.0)`
    - `cta_text: str = "Tonton selengkapnya di YouTube"`
    - `youtube_handle: str = ""`
    - `show_video_title: bool = True`
    - `instagram_handle: str = ""`
    - `tiktok_handle: str = ""`
    - `accent_color: str = "#FF0033"` (validated `#RRGGBB` hex)
  - `ExportSettings.outro: OutroSettings = Field(default_factory=OutroSettings)`

- [ ] **Step 1: Write failing config tests in `autoclip/tests/test_config.py`**

Add tests:
- `test_outro_defaults_and_round_trip`: verifies `settings.export.outro` default values (`enabled is False`, `duration_s == 3.0`, `cta_text == "Tonton selengkapnya di YouTube"`, `show_video_title is True`, `accent_color == "#FF0033"`), mutates fields, saves, reloads, asserts equality.
- `test_legacy_config_without_outro_loads_defaults`: writes a `config.json` containing `{"export": {"ratio": "1:1", "crf": 20}}` (no `outro` key), calls `config.load()`, asserts `ratio == "1:1"` and `outro.enabled is False`, `outro.duration_s == 3.0`.
- `test_outro_rejects_out_of_range_duration_and_bad_color`: asserts `ValidationError` for `duration_s=0.2`, `duration_s=12.0`, and `accent_color="not-a-color"`.

- [ ] **Step 2: Run tests to verify failure**

Run: `cd /home/prakoso-dev/clipper-apps/autoclip && .venv/bin/pytest tests/test_config.py -v`
Expected: FAIL (`AttributeError: 'ExportSettings' object has no attribute 'outro'`).

- [ ] **Step 3: Implement `OutroSettings` in `autoclip/backend/autoclip/config.py` and add `pillow>=10.0` to `autoclip/pyproject.toml`**

Define `OutroSettings(BaseModel)` right above `ExportSettings` with a `field_validator("accent_color")` enforcing `^#[0-9A-Fa-f]{6}$`, attach `outro: OutroSettings = Field(default_factory=OutroSettings)` to `ExportSettings`, and add `"pillow>=10.0"` under `dependencies` in `autoclip/pyproject.toml`.

- [ ] **Step 4: Run config tests**

Run: `cd /home/prakoso-dev/clipper-apps/autoclip && .venv/bin/pytest tests/test_config.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/prakoso-dev/clipper-apps/autoclip
git add pyproject.toml backend/autoclip/config.py tests/test_config.py
git commit -m "feat(config): add OutroSettings under ExportSettings"
```

---

### Task 2: Pillow Outro CTA Card Renderer

**Files:**
- Create: `autoclip/backend/autoclip/pipeline/outro.py`
- Test: `autoclip/tests/test_outro.py`

**Interfaces:**
- Consumes:
  - `autoclip.config.OutroSettings`
  - `autoclip.pipeline.captions.FONT_DIR` (`Anton-Regular.ttf`, `Inter-Variable.ttf`)
- Produces:
  - `OUTRO_FADE_S: float = 0.35`
  - `MIN_EFFECTIVE_OUTRO_S: float = 0.5`
  - `MAX_CLIP_FRACTION: float = 0.4`
  - `@dataclass(frozen=True) class OutroCardSpec`:
    - `settings: OutroSettings`
    - `video_title: str | None = None`
    - `source_channel: str | None = None`
  - `def effective_outro_duration(requested_s: float, clip_duration_s: float) -> float` (returns `0.0` if clipped duration `< MIN_EFFECTIVE_OUTRO_S`, else `min(requested_s, clip_duration_s * MAX_CLIP_FRACTION)`)
  - `def render_outro_card(spec: OutroCardSpec, *, width: int, height: int) -> Image.Image` (RGBA image of size `(width, height)`)
  - `def write_outro_card(path: Path, spec: OutroCardSpec, *, width: int, height: int) -> Path`
  - `def render_outro_preview_png(spec: OutroCardSpec, *, width: int, height: int) -> bytes` (composites the RGBA card onto a subtle studio-dark backdrop so the Settings UI preview looks realistic)

- [ ] **Step 1: Write failing unit tests in `autoclip/tests/test_outro.py`**

Include tests covering:
- `test_effective_outro_duration_clamps_and_skips`:
  - `effective_outro_duration(3.0, 30.0) == 3.0`
  - `effective_outro_duration(3.0, 5.0) == pytest.approx(2.0)` (40% cap)
  - `effective_outro_duration(3.0, 1.0) == 0.0` (`0.4 < 0.5` skips cleanly)
- `test_renders_all_ratios_as_rgba_with_scrim_and_card`: parametrized over `(1080, 1920)`, `(1080, 1080)`, `(1920, 1080)`; verifies RGBA mode, exact dimensions, non-zero alpha scrim at edges, opaque/bright pixels in card center, and red accent pixels present.
- `test_long_unicode_title_and_empty_handles_do_not_crash`: renders with a 140-character Indonesian title containing quotes & emoji, `youtube_handle=""`, `source_channel=None`, `instagram_handle=""`, `tiktok_handle=""`; verifies valid RGBA output and pixel variance.
- `test_youtube_handle_prefers_settings_over_source_channel`: verifies rendered card differs when `youtube_handle="@Custom"` vs `youtube_handle=""` with `source_channel="FallbackCh"`, and that `show_video_title=False` omits the title pill (different image bytes vs `True`).
- `test_write_outro_card_and_preview_png_bytes`: writes PNG to `tmp_path / "outro.png"` and checks valid PNG header (`\x89PNG`) for both file and `render_outro_preview_png(...)`.

- [ ] **Step 2: Run tests to verify failure**

Run: `cd /home/prakoso-dev/clipper-apps/autoclip && .venv/bin/pytest tests/test_outro.py -v`
Expected: FAIL (`ModuleNotFoundError: No module named 'autoclip.pipeline.outro'`).

- [ ] **Step 3: Implement `autoclip/backend/autoclip/pipeline/outro.py`**

Visual layout algorithm:
- Base layer: RGBA `(width, height)` with vertical dark scrim gradient (`alpha` ~135 at top/bottom, ~175 in center band, RGB `(8, 10, 14)`) for high readability without turning the live blurred footage opaque black.
- Safe-zone bounds: horizontal padding `int(width * 0.10)`, content width `width - 2 * pad_x`, vertical center at `int(height * 0.46)` for portrait (`height > width`) and `int(height * 0.50)` otherwise.
- Scale unit `u = min(width, height)` (`1080` across all 3 ratios):
  1. **YouTube Badge:** rounded pill (`accent_color`), white play triangle drawn as polygon + `"YOUTUBE"` in `Inter` bold (`~0.026 * u`).
  2. **CTA Headline:** `spec.settings.cta_text.strip().upper() or "TONTON SELENGKAPNYA DI YOUTUBE"` in `Anton-Regular.ttf` (`~0.064 * u` portrait / `~0.056 * u` landscape), word-wrapped to fit `content_w` (max 3 lines), centered white with subtle drop shadow.
  3. **Full Video Title Card** (when `show_video_title` and `video_title`): frosted rounded box (`rgba(255, 255, 255, 24)` fill, `rgba(255, 255, 255, 58)` outline), text in `Inter` (`~0.032 * u`), word-wrapped max 2 lines with `…` truncation via pixel-width measurement (`font.getlength`).
  4. **Channel Handle** (`youtube_handle.strip() or (source_channel or "").strip()`): bold `Inter` (`~0.034 * u`), light silver-white `#F1F5F9`.
  5. **Social Footer** (only when `instagram_handle.strip()` or `tiktok_handle.strip()`): compact single line (`IG @...  ·  TikTok @...`, auto-prefixing `@` if omitted) in muted `#CBD5E1` (`~0.026 * u`).
- Measure total stack height first, then draw top-down centered around the target Y so spacing stays perfectly balanced regardless of which optional rows are present.

- [ ] **Step 4: Run outro tests**

Run: `cd /home/prakoso-dev/clipper-apps/autoclip && .venv/bin/pytest tests/test_outro.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/prakoso-dev/clipper-apps/autoclip
git add backend/autoclip/pipeline/outro.py tests/test_outro.py
git commit -m "feat(outro): add Pillow CTA overlay card generator"
```

---

### Task 3: FFmpeg Live-Blur Overlay in Export Pipeline

**Files:**
- Modify: `autoclip/backend/autoclip/pipeline/export.py:48-145,234-325`
- Test: `autoclip/tests/test_export_render.py`

**Interfaces:**
- Consumes:
  - `autoclip.pipeline.outro.OutroCardSpec`, `OUTRO_FADE_S`, `effective_outro_duration`, `write_outro_card`
- Produces:
  - `ExportRequest.outro: OutroCardSpec | None = None`
  - `build_video_filtergraph(request: ExportRequest, *, subtitle_name: str | None, fonts_name: str = "fonts", outro_input_index: int | None = None) -> str`

- [ ] **Step 1: Write failing unit & FFmpeg render tests in `autoclip/tests/test_export_render.py`**

Add a `TestOutroOverlayRender` class (and a fast unit test for `build_video_filtergraph` without slow mark, or in `tests/test_outro.py` for fast feedback):
- Fast filtergraph unit tests in `autoclip/tests/test_outro.py`:
  - `test_filtergraph_without_outro_has_no_outro_nodes`: asserts `"boxblur=20:2"` not in graph.
  - `test_filtergraph_with_outro_trims_only_tail_and_overlays`: asserts `trim=start=3.0000`, `boxblur=20:2`, `[1:v]overlay=0:0`, `fade=t=in:st=0:d=0.3500:alpha=1`, `enable='gte(t,3.0000)'`, and `[vout]` present.
  - `test_filtergraph_skips_outro_on_very_short_clip`: 1.0s clip with 3.0s outro -> no outro nodes emitted.
- Real FFmpeg render tests in `autoclip/tests/test_export_render.py`:
  - `test_outro_overlay_preserves_duration_and_changes_only_tail`: renders 5.0s clip twice (with and without `OutroCardSpec(OutroSettings(enabled=True, duration_s=2.0, youtube_handle="@TestCh"), video_title="Full Episode Title")`), asserts:
    - both have `(1080, 1920)`, `yuv420p`, `has_audio`, and `duration_s == pytest.approx(5.0, abs=0.35)` (zero added duration!)
    - early frame at `t=1.0` has identical `_frame_signature` to non-outro render (early clip completely untouched!)
    - tail frame at `t=4.2` has different `_frame_signature` from non-outro render (blur + CTA visibly rendered!)
  - `test_outro_overlay_works_with_multi_segment_and_special_path`: renders a 2-segment crop path clip with outro into a directory with spaces/apostrophe (`My Clips (2026)/it's here`), asserts output exists, exact dimensions, duration `~5.0s`.
  - `test_outro_overlay_works_without_captions`: `burn_captions=False` + outro -> succeeds cleanly.

- [ ] **Step 2: Run new tests to verify failure**

Run: `cd /home/prakoso-dev/clipper-apps/autoclip && .venv/bin/pytest tests/test_outro.py tests/test_export_render.py -k outro -v`
Expected: FAIL (`TypeError: ExportRequest.__init__() got an unexpected keyword argument 'outro'`).

- [ ] **Step 3: Implement outro overlay support in `autoclip/backend/autoclip/pipeline/export.py`**

- Add `outro: OutroCardSpec | None = None` to `ExportRequest`.
- In `build_video_filtergraph(..., outro_input_index: int | None = None)`:
  - Compute `eff_outro_s = effective_outro_duration(request.outro.settings.duration_s, request.duration_s)` when `request.outro is not None and outro_input_index is not None` else `0.0`.
  - If `eff_outro_s == 0.0`, keep the exact existing caption/`null` tail (`[vout]`).
  - Otherwise:
    - `outro_start = max(0.0, request.duration_s - eff_outro_s)`
    - `fade_s = min(OUTRO_FADE_S, eff_outro_s * 0.4)`
    - Split `current` (pre-caption reframed stream): `f"{current}split=2[vpre_main][vpre_outro]"`
    - Apply captions to `[vpre_main]` -> `[vmain]` (or `null` if no captions).
    - Tail blur + PNG overlay + fade-in + PTS shift:
      - `f"[vpre_outro]trim=start={outro_start:.4f},setpts=PTS-STARTPTS,boxblur=20:2[voutro_blur]"`
      - `f"[voutro_blur][{outro_input_index}:v]overlay=0:0,format=rgba,fade=t=in:st=0:d={fade_s:.4f}:alpha=1,setpts=PTS+{outro_start:.4f}/TB[voutro]"`
    - Composite topmost onto `[vmain]`:
      - `f"[vmain][voutro]overlay=0:0:enable='gte(t,{outro_start:.4f})':eof_action=pass,format=yuv420p[vout]"`
- In `export_clip(...)`:
  - When `request.outro is not None` and `effective_outro_duration(request.outro.settings.duration_s, request.duration_s) > 0`:
    - Call `write_outro_card(workspace / "outro.png", request.outro, width=out_w, height=out_h)`
    - Pass `outro_input_index=1` to `build_video_filtergraph(...)`
    - Add `"-i", str(outro_png_path)` immediately after `"-i", str(request.source)` in `_build_args`.

- [ ] **Step 4: Run outro + full export render test suite**

Run: `cd /home/prakoso-dev/clipper-apps/autoclip && .venv/bin/pytest tests/test_outro.py tests/test_export_render.py -v`
Expected: PASS (all existing + new render tests green).

- [ ] **Step 5: Commit**

```bash
cd /home/prakoso-dev/clipper-apps/autoclip
git add backend/autoclip/pipeline/export.py tests/test_outro.py tests/test_export_render.py
git commit -m "feat(export): composite live-blurred outro CTA overlay at clip tail"
```

---

### Task 4: Settings Preview & Export Override REST API

**Files:**
- Modify: `autoclip/backend/autoclip/api/schemas.py:202-207`
- Modify: `autoclip/backend/autoclip/api/settings.py:56-72,85+`
- Modify: `autoclip/backend/autoclip/api/clips.py:171-225`
- Test: `autoclip/tests/test_api.py`

**Interfaces:**
- Consumes:
  - `autoclip.config.OutroSettings`
  - `autoclip.pipeline.outro.OutroCardSpec`, `render_outro_preview_png`
  - `autoclip.pipeline.export.ExportRequest.outro`, `ratio_dimensions`
- Produces:
  - `ExportRequestIn.include_outro: bool | None = None`
  - `GET /api/settings/outro-preview?ratio=9:16` -> `Response(content=png_bytes, media_type="image/png")` (400 on unknown ratio)
  - Nested deep-merge of `export.outro` in `PUT /api/settings`

- [ ] **Step 1: Write failing API tests in `autoclip/tests/test_api.py`**

Add tests:
- `test_nested_outro_partial_update_preserves_siblings`:
  - `PUT /api/settings` with `{"export": {"outro": {"youtube_handle": "@MyChannel", "cta_text": "Watch full"}}}`
  - Then `PUT /api/settings` with `{"export": {"outro": {"enabled": True}}}`
  - Asserts `enabled is True`, `youtube_handle == "@MyChannel"`, `cta_text == "Watch full"`, AND `export.ratio == "9:16"`, `export.loudness_lufs == -14.0`.
- `test_outro_preview_returns_png_for_valid_ratios_and_400_for_invalid`:
  - `GET /api/settings/outro-preview?ratio=9:16` -> `200`, `content-type == "image/png"`, body starts with `\x89PNG`.
  - `GET /api/settings/outro-preview?ratio=4:3` -> `400`.
- `test_export_clip_respects_include_outro_override`:
  - Monkeypatches `export_module.export_clip` to capture `ExportRequest` and write dummy bytes to `request.destination`.
  - Sets `settings.export.outro.enabled = True`, exports with `include_outro=False` -> asserts captured `request.outro is None`.
  - Sets `settings.export.outro.enabled = False`, exports with `include_outro=True` -> asserts captured `request.outro is not None` and `request.outro.video_title == source.title` and `request.outro.source_channel == source.channel`.
  - Exports with `include_outro` omitted (`None`) when `enabled=True` -> asserts captured `request.outro is not None`.

- [ ] **Step 2: Run API tests to verify failure**

Run: `cd /home/prakoso-dev/clipper-apps/autoclip && .venv/bin/pytest tests/test_api.py -k "outro" -v`
Expected: FAIL.

- [ ] **Step 3: Implement API changes**

- In `autoclip/backend/autoclip/api/schemas.py`: add `include_outro: bool | None = None` to `ExportRequestIn`.
- In `autoclip/backend/autoclip/api/settings.py`:
  - Deep-merge nested dicts (specifically `export.outro`) before `model_validate` in `put_settings` so partial updates to `export.outro` preserve untouched keys.
  - Add `@router.get("/settings/outro-preview")` accepting `ratio: str = "9:16"`, validating via `export_module.ratio_dimensions(ratio)` (raising 400 on `ExportError`), building `OutroCardSpec(settings=settings.export.outro, video_title="Judul Video Lengkap di YouTube", source_channel=settings.export.outro.youtube_handle or "@NamaChannel")`, and returning `Response(content=png, media_type="image/png", headers={"Cache-Control": "no-store"})`.
- In `autoclip/backend/autoclip/api/clips.py`:
  - In `export_clip`: determine `use_outro = settings.export.outro.enabled if payload.include_outro is None else payload.include_outro`.
  - If `use_outro`, pass `outro=OutroCardSpec(settings=settings.export.outro, video_title=source.title or None, source_channel=source.channel)` to `ExportRequest`.

- [ ] **Step 4: Run full backend test suite**

Run: `cd /home/prakoso-dev/clipper-apps/autoclip && .venv/bin/pytest tests/test_api.py tests/test_config.py tests/test_outro.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/prakoso-dev/clipper-apps/autoclip
git add backend/autoclip/api/schemas.py backend/autoclip/api/settings.py backend/autoclip/api/clips.py tests/test_api.py
git commit -m "feat(api): add outro preview endpoint and per-export include_outro override"
```

---

### Task 5: Frontend Settings Live Preview & Review Player/Export Controls

**Files:**
- Modify: `autoclip/frontend/src/api.ts`
- Modify: `autoclip/frontend/src/pages/Settings.tsx`
- Modify: `autoclip/frontend/src/components/ClipPlayer.tsx`
- Modify: `autoclip/frontend/src/pages/Review.tsx`
- Rebuild: `autoclip/backend/autoclip/static/**` (via `npm run build`)

**Interfaces:**
- Consumes:
  - `GET/PUT /api/settings` (`export.outro`)
  - `GET /api/settings/outro-preview?ratio=...`
  - `POST /api/clips/{id}/export` (`include_outro`)
- Produces:
  - `OutroSettings` TypeScript interface in `frontend/src/api.ts`
  - `api.outroPreviewUrl(ratio: string, version: number): string`
  - `api.exportClip(clipId, ratio, style, writeSrt?, includeOutro?)`
  - Live outro settings & PNG preview section in `Settings.tsx`
  - Live blurred CTA overlay preview in `ClipPlayer.tsx` during final `effOutroS` seconds
  - Per-clip *"Include YouTube CTA overlay"* toggle in `Review.tsx`

- [ ] **Step 1: Update `autoclip/frontend/src/api.ts`**

Add `OutroSettings` interface, attach `outro: OutroSettings` to `Settings['export']`, add `includeOutro?: boolean` optional param to `api.exportClip`, and add `api.outroPreviewUrl(ratio: string, bust: number) => \`/api/settings/outro-preview?ratio=\${encodeURIComponent(ratio)}&v=\${bust}\``.

- [ ] **Step 2: Add Outro CTA settings & live PNG preview to `autoclip/frontend/src/pages/Settings.tsx`**

Add a dedicated `<Section title="YouTube Outro CTA" note="Live-blurred overlay in the final seconds of each clip — zero added duration.">` with:
- Enable toggle (`settings.export.outro.enabled`)
- Two-column layout: form controls on the left (`CTA text`, `Duration (s)`, `YouTube handle`, checkbox `Show full video title from source`, optional `Instagram handle`, optional `TikTok handle`) and a live preview panel on the right displaying `<img src={api.outroPreviewUrl(previewRatio, previewVersion)} />` with a compact `9:16 | 1:1 | 16:9` ratio switcher. Increment `previewVersion` after each `patch(...)` completes so the image immediately reflects saved changes.

- [ ] **Step 3: Add live blurred CTA overlay preview to `autoclip/frontend/src/components/ClipPlayer.tsx`**

Accept optional `outro?: { settings: OutroSettings; videoTitle?: string; sourceChannel?: string | null } | null`.
When `outro` is provided, compute `effOutroS = Math.min(outro.settings.duration_s, duration * 0.4)`. If `effOutroS >= 0.5` and `elapsed >= duration - effOutroS`:
- Compute fade progress `alpha = Math.min(1, (elapsed - (duration - effOutroS)) / 0.35)`.
- Hide `<CaptionOverlay>` cleanly as `alpha` rises (opacity `1 - alpha`) and render `<OutroOverlay>` on top with CSS `backdropFilter: blur(12px)`, dark gradient scrim, YouTube red pill, CTA text, optional title card, channel handle, and optional IG/TikTok footer — matching the backend Pillow layout so timing and framing are immediately visible while scrubbing/playing.

- [ ] **Step 4: Wire `includeOutro` toggle and preview into `autoclip/frontend/src/pages/Review.tsx`**

- Fetch `api.getSettings()` alongside `getJob`/`listClips`/`captionStyles`.
- Maintain `outroSettings: OutroSettings | null` and `includeOutro: boolean` (initialized from `loadedSettings.export.outro.enabled`).
- Pass `outro={includeOutro && outroSettings ? { settings: outroSettings, videoTitle: job?.source?.title, sourceChannel: job?.source?.channel } : null}` to `<ClipPlayer />`.
- Render a clean checkbox *"Include YouTube CTA overlay"* directly above the **Export this clip** button; pass `includeOutro` into `api.exportClip(clip.id, clip.ratio, clip.caption_style, false, includeOutro)` (used by both single export and `Export kept`).

- [ ] **Step 5: Typecheck, build frontend bundle, and run full backend tests**

Run:
```bash
cd /home/prakoso-dev/clipper-apps/autoclip/frontend && npx tsc --noEmit && npm run build
cd /home/prakoso-dev/clipper-apps/autoclip && .venv/bin/pytest -v
```
Expected: TypeScript check passes with 0 errors, Vite builds `backend/autoclip/static/` cleanly, and all pytest suites pass.

- [ ] **Step 6: Commit**

```bash
cd /home/prakoso-dev/clipper-apps/autoclip
git add frontend/src/api.ts frontend/src/pages/Settings.tsx frontend/src/components/ClipPlayer.tsx frontend/src/pages/Review.tsx backend/autoclip/static
git commit -m "feat(ui): add YouTube outro CTA settings preview and review toggle"
```
