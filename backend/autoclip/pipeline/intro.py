"""Minimalist Floating Intro Hook & Subtle Channel Watermark PNG renderer.

Renders transparent RGBA overlays positioned inside the TikTok / Instagram Reels /
YouTube Shorts top safe zone so they never cover the speaker's face or clash with
bottom captions.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw

from .outro import (
    _GOLD_ACCENT,
    _hex_to_rgb,
    _line_height,
    _load_font,
    _overlay_draw,
    _wrap_text,
)

#: Smooth entry/exit timing for the Intro Hook banner.
INTRO_FADE_IN_S: float = 0.30
INTRO_FADE_OUT_S: float = 0.35
INTRO_SLIDE_S: float = 0.35
MIN_EFFECTIVE_INTRO_S: float = 0.5
MAX_INTRO_CLIP_FRACTION: float = 0.4


@dataclass(frozen=True)
class IntroHookSpec:
    """Minimalist floating headline shown at the start of a clip."""

    text: str
    duration_s: float = 3.0
    accent_color: str = "#FF0033"


@dataclass(frozen=True)
class WatermarkSpec:
    """Subtle persistent channel watermark at the top safe zone."""

    text: str


def effective_intro_duration(requested_s: float, clip_duration_s: float) -> float:
    """Clamp intro hook length safely against the clip's duration."""
    if requested_s <= 0 or clip_duration_s <= 0:
        return 0.0
    clamped = min(requested_s, clip_duration_s * MAX_INTRO_CLIP_FRACTION)
    return clamped if clamped >= MIN_EFFECTIVE_INTRO_S else 0.0


def render_intro_hook(spec: IntroHookSpec, *, width: int, height: int) -> Image.Image:
    """Render the Minimalist Floating Editorial intro hook overlay as transparent RGBA."""
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    text = (spec.text or "").strip()
    if not text:
        return canvas

    is_portrait = height > width
    u = float(width) if is_portrait else float(height) * 0.85
    center_x = width // 2

    # Soft dark top vignette gradient so floating text pops over bright studio walls
    # without looking like a box.
    vig_h = int(height * (0.28 if is_portrait else 0.32))
    vig_col = Image.new("RGBA", (1, vig_h))
    vig_col.putdata(
        [(8, 10, 16, int(152 * (1.0 - y / max(1, vig_h - 1)) ** 1.6)) for y in range(vig_h)]
    )
    vig_layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    vig_layer.paste(vig_col.resize((width, vig_h), Image.Resampling.BILINEAR), (0, 0))
    canvas = Image.alpha_composite(canvas, vig_layer)

    headline_font = _load_font("Anton-Regular.ttf", int(u * (0.059 if is_portrait else 0.056)))
    max_text_w = int(width * (0.78 if is_portrait else 0.72))
    lines = _wrap_text(text.upper(), headline_font, max_text_w, max_lines=2, ellipsis=True)
    lh = _line_height(headline_font, factor=1.10)

    # Sit right below the top safe-zone watermark slot (Y ~ 14.5% on 9:16).
    top_y = int(height * (0.142 if is_portrait else 0.115))
    shadow_dy = max(2, int(u * 0.004))
    accent_rgb = _hex_to_rgb(spec.accent_color)

    def _draw(d: ImageDraw.ImageDraw) -> None:
        cy = top_y
        for idx, line in enumerate(lines):
            is_accent_line = len(lines) > 1 and idx == len(lines) - 1
            fill = _GOLD_ACCENT if is_accent_line else (255, 255, 255, 255)
            d.text(
                (center_x, cy + lh // 2 + shadow_dy),
                line,
                font=headline_font,
                fill=(0, 0, 0, 185),
                anchor="mm",
            )
            d.text((center_x, cy + lh // 2), line, font=headline_font, fill=fill, anchor="mm")
            cy += lh

        # Thin accent underline right below the headline.
        bar_half = int(u * 0.050)
        bar_h = max(4, int(u * 0.0065))
        bar_y = cy + int(u * 0.010)
        d.rounded_rectangle(
            [center_x - bar_half, bar_y, center_x + bar_half, bar_y + bar_h],
            radius=bar_h // 2,
            fill=(*accent_rgb, 245),
        )

    return _overlay_draw(canvas, _draw)


def write_intro_hook(path: Path, spec: IntroHookSpec, *, width: int, height: int) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    render_intro_hook(spec, width=width, height=height).save(path, format="PNG")
    return path


def render_watermark(spec: WatermarkSpec, *, width: int, height: int) -> Image.Image:
    """Render a subtle persistent channel watermark at the upper safe zone."""
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    text = (spec.text or "").strip()
    if not text:
        return canvas

    is_portrait = height > width
    u = float(width) if is_portrait else float(height) * 0.85
    center_x = width // 2
    wm_y = int(height * (0.103 if is_portrait else 0.068))
    wm_font = _load_font("Inter-Variable.ttf", int(u * 0.022), weight=600)
    shadow_dy = max(1, int(u * 0.002))

    return _overlay_draw(
        canvas,
        lambda d: (
            d.text(
                (center_x, wm_y + shadow_dy),
                text,
                font=wm_font,
                fill=(0, 0, 0, 145),
                anchor="mm",
            ),
            d.text(
                (center_x, wm_y),
                text,
                font=wm_font,
                fill=(255, 255, 255, 205),
                anchor="mm",
            ),
        ),
    )


def write_watermark(path: Path, spec: WatermarkSpec, *, width: int, height: int) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    render_watermark(spec, width=width, height=height).save(path, format="PNG")
    return path
