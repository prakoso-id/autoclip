# Outro CTA Overlay — Design Spec

**Date:** 2026-11-25
**Status:** Draft (pending user approval)
**Scope:** Medium feature (backend outro renderer + FFmpeg export integration + REST API + Settings & Review UI)

## 1. Intent & Why

AutoClip clips are published to short-form platforms (Instagram Reels, TikTok, YouTube Shorts), while the full long-form video lives on YouTube. The user wants a clean, built-in "bridge" at the end of every clip directing viewers to watch the full video on YouTube (and optionally follow social handles) **without needing external design assets** (Canva/After Effects/MP4 bumpers).

To preserve short-form viewer retention, the outro must appear **before the clip finishes** as a topmost overlay over the **still-moving, smoothly blurred** clip background — keeping the video alive and adding **zero extra duration** or awkward trailing silence.

## 2. Goals, Non-Goals & Anti-Goals

### Goals
- Zero external assets required: AutoClip generates crisp, ratio-aware (`9:16`, `1:1`, `16:9`) CTA cards automatically using Pillow and the already-bundled `Anton` and `Inter` fonts.
- Zero added duration: the overlay activates during the final `duration_s` seconds (default `3.0s`) of the clip while the underlying clip keeps playing and audio continues normally.
- Live blurred background: only the final `N` seconds of the video smoothly cross-fade (`~0.35s`) into a live moving blurred + darkened background underneath the CTA card.
- Automatic YouTube metadata fill: when the source came from YouTube, `source.title` and `source.channel` automatically populate the full-video title and fallback channel handle.
- WYSIWYG preview: live preview in Settings (served from the exact backend PNG renderer) and real-time preview inside `ClipPlayer` during the final `N` seconds on the Review page.
- Per-clip export override: default setting in Settings, with an on/off toggle on the Review page before exporting.

### Non-Goals
- Uploading custom PNG/MP4 outro assets (can be layered on later without breaking this design).
- Complex keyframed motion graphics / per-word animations inside the CTA card.
- Adding extra tail duration or background music tracks after the clip ends.
- Interactive clickable links inside MP4 (platforms handle links outside video pixels).

### Anti-Goals
- **Caption collision:** Captions must never remain visibly cluttered behind or over the CTA text. Because the blurred live video + CTA overlay fades in on top of the captioned stream at full opacity, captions cleanly disappear behind the blur.
- **Frozen / dead outro screen:** Background must remain live moving video (not a static frozen frame).
- **Wasted render time:** FFmpeg must only run `boxblur` on the final `N` seconds, not the entire clip.
- **Unreadable tiny text on mobile:** Typography must scale proportionally to the output canvas (`9:16`, `1:1`, `16:9`) with safe margins away from TikTok/Reels/Shorts UI chrome.

## 3. Approaches Considered

1. **Static Post-Clip End-Card (`concat` after clip):** Appends 2–4s frozen blurred last frame + CTA card after the clip ends. Simple, but adds duration and creates an abrupt visual freeze/silence where short-form viewers immediately swipe away.
2. **Animated Motion Graphics Post-Clip End-Card:** Same as (1) with motion animations. Looks livelier, but higher implementation complexity, slower renders, and still appends extra duration.
3. **Live-Blurred Topmost Overlay at End of Clip (Chosen):** Appears over the final `N` seconds of the clip as the topmost layer with a smooth fade into a live moving blurred video + dark scrim + auto-generated CTA card. **Chosen** because it adds zero duration, keeps motion and audio alive for higher retention, requires no user assets, and cleanly hides captions during the overlay window.

## 4. Architecture & Design

### 4.1 Configuration (`autoclip/backend/autoclip/config.py`)

Add an `OutroSettings` Pydantic model nested under `ExportSettings` (or top-level `outro: OutroSettings` on `Settings`; **designer call: nested under `ExportSettings.outro`** so all render/export knobs stay together, with backward-compatible defaults so existing `config.json` files load cleanly):

```python
class OutroSettings(BaseModel):
    enabled: bool = False
    duration_s: float = 3.0          # clamped to [1.0, 8.0]; also clamped at render time to <= 40% of clip duration
    cta_text: str = "Tonton selengkapnya di YouTube"
    youtube_handle: str = ""         # e.g. "@NamaChannel"; falls back to source.channel if empty
    show_video_title: bool = True    # shows source.title when available
    instagram_handle: str = ""       # optional; shown only when non-empty
    tiktok_handle: str = ""          # optional; shown only when non-empty
    accent_color: str = "#FF0033"    # YouTube red accent for badge/highlights
```

*Defaults & safety:*
- `enabled` defaults to `False` so existing users/tests aren't surprised until they configure their channel/handles and turn it on.
- `fade_s` is a constant `0.35` seconds (smooth fade-in without needing another user knob).

### 4.2 Card Renderer (`autoclip/backend/autoclip/pipeline/outro.py`)

A dedicated, pure-Python module using `Pillow` (`PIL.Image`, `PIL.ImageDraw`, `PIL.ImageFont`) and AutoClip's bundled fonts in `assets/fonts/` (`Anton-Regular.ttf` for display headline, `Inter-Variable.ttf` for body/handles):

- **Input:** `OutroCardSpec` (output width & height from `RATIOS`, `OutroSettings`, optional `video_title: str | None`, optional `source_channel: str | None`).
- **Output:** Transparent RGBA PNG (`out_w x out_h`) written to disk (or returned as PNG bytes for the Settings preview endpoint).
- **Visual composition (safe-zone aware for Reels/TikTok/Shorts):**
  - Full-canvas soft dark scrim gradient (`rgba(8, 10, 14, 150)` slightly darker toward center/edges) so white text always meets high contrast over bright or busy footage.
  - Centered vertical stack positioned slightly above dead-center (`~46%` vertical center on `9:16` to clear bottom platform captions/UI and right-side action buttons, with `>= 10%` horizontal margins):
    1. **YouTube Badge:** Crisp vector-drawn rounded red pill (`accent_color`) with a clean white play triangle + `"YOUTUBE"` label.
    2. **CTA Headline:** Uppercase bold `Anton` text (e.g. `"TONTON SELENGKAPNYA DI YOUTUBE"`), auto-wrapped cleanly to max 2–3 lines.
    3. **Full Video Title (optional):** Inside a subtle frosted dark pill/card (`rgba(255, 255, 255, 22)` fill + `rgba(255, 255, 255, 45)` 1px border), wrapped cleanly up to 2 lines with ellipsis if long.
    4. **Channel Handle:** Clean bold `Inter` text (e.g. `@NamaChannel`, from `youtube_handle` or fallback `source_channel`).
    5. **Optional Social Footer:** Compact subtle row at the bottom of the stack (`IG @...  ·  TikTok @...`) rendered only if either handle is filled.
- Layout scales proportionally off `min(out_w, out_h)` and `out_h` so `9:16` (`1080x1920`), `1:1` (`1080x1080`), and `16:9` (`1920x1080`) all look balanced.

### 4.3 Export Filtergraph (`autoclip/backend/autoclip/pipeline/export.py`)

Extend `ExportRequest` with optional `outro: OutroRenderSpec | None = None` (resolved from `ExportSettings.outro` + `source.title` + `source.channel` + per-export `include_outro` flag).

When `outro` is active and effective duration `eff_outro_s = min(outro.duration_s, request.duration_s * 0.4)` is `>= 0.5s`:
- Render `workspace / "outro.png"` via `pipeline/outro.py`.
- Pass `-i <outro.png>` as FFmpeg input `[1:v]`.
- In `build_video_filtergraph`:
  1. Let `[vbase]` be the cropped/scaled video stream (`[v0]` or `[vcat]`) **before** `ass` captions.
  2. Split `[vbase]` into `[vbase_main][vbase_outro]`.
  3. Main branch applies captions if enabled (`[vbase_main]ass=...[vmain]` or `[vbase_main]null[vmain]`).
  4. Outro branch trims **only** the final `eff_outro_s` seconds (zero wasted blur work on earlier footage):
     - `[vbase_outro]trim=start={outro_start:.4f},setpts=PTS-STARTPTS,boxblur=20:2[vblur]`
     - `[vblur][1:v]overlay=0:0,format=rgba,fade=t=in:st=0:d={fade_s:.4f}:alpha=1,setpts=PTS+{outro_start:.4f}/TB[voutro]`
  5. Composite topmost onto `[vmain]`:
     - `[vmain][voutro]overlay=0:0:enable='gte(t,{outro_start:.4f})':eof_action=pass,format=yuv420p[vout]`
- Audio filtergraph (`loudnorm`) and total output duration remain **100% unchanged**.
- Note: `system.py` `REQUIRED_FILTERS` already checks `crop`, `scale`, `ass`, `concat`, `loudnorm`; `boxblur`, `overlay`, `fade`, `trim` are all standard built-in FFmpeg filters (and `boxblur`/`overlay` are already used by `_fit_chain` in `export.py`).

### 4.4 Backend API (`api/settings.py`, `api/clips.py`, `api/schemas.py`)

- `GET/PUT /api/settings`: automatically includes `export.outro` (with nested merge support in `put_settings` so partial updates to `export.outro` don't wipe sibling fields in `export`).
- `GET /api/settings/outro-preview?ratio=9:16`: returns `image/png` rendered directly by `pipeline/outro.py` using the current saved `OutroSettings` (and sample title/channel placeholders when empty), composited over a subtle dark gradient backdrop so the Settings UI shows an exact pixel-accurate preview.
- `POST /api/clips/{clip_id}/export`: add optional `include_outro: bool | None = None` to `ExportRequestIn`. When `None`, uses `settings.export.outro.enabled`; when `True`/`False`, overrides for that export.

### 4.5 Frontend UI (`Settings.tsx`, `Review.tsx`, `ClipPlayer.tsx`, `api.ts`)

1. **Settings → Export → Outro CTA Overlay:**
   - Master checkbox: *"Enable YouTube CTA overlay at end of clips"*.
   - Fields: CTA headline text, Duration (`s`), YouTube channel/handle (`@channel`), checkbox *"Auto-show full YouTube video title"*, optional Instagram handle, optional TikTok handle.
   - Side-by-side **Live Preview** card showing the real PNG from `/api/settings/outro-preview` (refreshed whenever settings save, with ratio selector preview).
2. **Review Page (`Review.tsx` + `ClipPlayer.tsx`):**
   - Loads `settings.export.outro` on mount; initializes per-clip `includeOutro` toggle from `settings.export.outro.enabled`.
   - Adds a clean checkbox *"Include YouTube CTA overlay"* right above the **Export this clip** button (also respected by **Export kept**).
   - Inside `ClipPlayer.tsx`: when `outro` is enabled and playback time enters the final `outro.duration_s` seconds (`elapsed >= duration - effOutroS`), smoothly applies CSS `backdrop-filter: blur(...)` + dark scrim + the CTA card preview on top of the playing video (hiding CSS captions underneath), so the user can preview the exact timing and feel before rendering!

## 5. Calls Left to Implementation / Builder

- Exact typography sizing ratios, line-wrapping thresholds, and card padding tuned visually against real `9:16`, `1:1`, and `16:9` test renders.
- Ensuring `Pillow` is explicitly declared in `autoclip/pyproject.toml` dependencies (currently installed transitively in the environment, should be explicit).
- Adding unit tests for `outro.py` PNG generation (all 3 ratios, long title wrapping, optional handles), `export.py` filtergraph construction with/without outro, and real FFmpeg render verification test in `tests/test_export_render.py`.
