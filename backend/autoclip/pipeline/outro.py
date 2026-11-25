"""Outro CTA card renderer — transparent RGBA overlays composited over a live-blurred tail.

Generates ratio-aware YouTube bridge cards using Pillow and AutoClip's bundled
fonts (Anton + Inter), so creators don't need external Canva/CapCut assets.
"""

from __future__ import annotations

import contextlib
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from ..config import OutroSettings
from .captions import FONT_DIR

#: Smooth alpha fade-in length for the blurred tail + CTA overlay.
OUTRO_FADE_S: float = 0.35
#: Skip the outro if clamping to MAX_CLIP_FRACTION leaves less than this.
MIN_EFFECTIVE_OUTRO_S: float = 0.5
#: Never cover more than 40% of a clip with the outro overlay.
MAX_CLIP_FRACTION: float = 0.4

_DEFAULT_CTA = "Tonton selengkapnya di YouTube"


@dataclass(frozen=True)
class OutroCardSpec:
    """Everything needed to render one clip's CTA overlay card."""

    settings: OutroSettings
    video_title: str | None = None
    source_channel: str | None = None


def effective_outro_duration(requested_s: float, clip_duration_s: float) -> float:
    """Clamp outro length safely against the clip's duration.

    Returns ``0.0`` when the clip is too short to show a readable overlay.
    """
    if requested_s <= 0 or clip_duration_s <= 0:
        return 0.0
    clamped = min(requested_s, clip_duration_s * MAX_CLIP_FRACTION)
    return clamped if clamped >= MIN_EFFECTIVE_OUTRO_S else 0.0


def _hex_to_rgb(colour: str) -> tuple[int, int, int]:
    value = colour.lstrip("#")
    return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16))


def _load_font(filename: str, size: int, *, weight: int | None = None) -> ImageFont.FreeTypeFont:
    font_path = FONT_DIR / filename
    clamped_size = max(10, size)
    font = ImageFont.truetype(str(font_path), size=clamped_size)
    if weight is not None:
        with contextlib.suppress(Exception):
            axes = font.get_variation_axes()
            values = [
                weight
                if axis["name"] == b"Weight"
                else min(axis["maximum"], max(axis["minimum"], clamped_size))
                for axis in axes
            ]
            if values:
                font.set_variation_by_axes(values)
    return font


def _format_handle(raw: str) -> str:
    cleaned = raw.strip()
    if not cleaned:
        return ""
    return cleaned if cleaned.startswith("@") else f"@{cleaned}"


def _wrap_text(
    text: str,
    font: ImageFont.FreeTypeFont,
    max_width: float,
    *,
    max_lines: int,
    ellipsis: bool = True,
) -> list[str]:
    """Word-wrap text to pixel width, truncating the last line cleanly if needed."""
    words = text.split()
    if not words:
        return []

    lines: list[str] = []
    current = ""

    def _fit_single_word(word: str) -> str:
        if font.getlength(word) <= max_width:
            return word
        suffix = "…" if ellipsis else ""
        lo, hi = 1, len(word)
        best = word[:1] + suffix
        while lo <= hi:
            mid = (lo + hi) // 2
            candidate = word[:mid] + suffix
            if font.getlength(candidate) <= max_width:
                best = candidate
                lo = mid + 1
            else:
                hi = mid - 1
        return best

    for idx, word in enumerate(words):
        candidate = f"{current} {word}".strip()
        if font.getlength(candidate) <= max_width:
            current = candidate
            continue

        if current:
            lines.append(current)
            if len(lines) == max_lines:
                # Truncate the final line with ellipsis to show continuation.
                if ellipsis:
                    lines[-1] = _truncate_to_width(lines[-1], font, max_width)
                return lines
            current = _fit_single_word(word)
        else:
            lines.append(_fit_single_word(word))
            if len(lines) == max_lines:
                return lines
            current = ""

        # If this was the last word and we still exceeded max_lines on the next line.
        if idx == len(words) - 1 and current:
            lines.append(current)
            return lines[:max_lines]

    if current:
        lines.append(current)
    return lines[:max_lines]


def _truncate_to_width(line: str, font: ImageFont.FreeTypeFont, max_width: float) -> str:
    text = line.rstrip(" .,;:-–—")
    while text and font.getlength(text + "…") > max_width:
        text = text[:-1].rstrip()
    return (text + "…") if text else "…"


def _line_height(font: ImageFont.FreeTypeFont, factor: float = 1.18) -> int:
    ascent, descent = font.getmetrics()
    return max(1, int((ascent + descent) * factor))


def _make_scrim(width: int, height: int) -> Image.Image:
    """Translucent dark vertical gradient scrim that preserves live-blur motion underneath."""
    column = Image.new("RGBA", (1, height))
    pixels = []
    for y in range(height):
        # Slightly darker in the middle band where the CTA text sits, softer at edges.
        norm = abs((y / max(1, height - 1)) - 0.48) * 2.0
        alpha = int(172 - min(1.0, norm) * 42)
        pixels.append((8, 10, 14, alpha))
    column.putdata(pixels)
    return column.resize((width, height), Image.Resampling.BILINEAR)


def _social_footer_text(settings: OutroSettings) -> str:
    parts: list[str] = []
    ig = _format_handle(settings.instagram_handle)
    tt = _format_handle(settings.tiktok_handle)
    if ig:
        parts.append(f"IG {ig}")
    if tt:
        parts.append(f"TikTok {tt}")
    return "   ·   ".join(parts)


def render_outro_card(spec: OutroCardSpec, *, width: int, height: int) -> Image.Image:
    """Render a transparent RGBA outro CTA card sized to ``(width, height)``."""
    canvas = _make_scrim(width, height)
    draw = ImageDraw.Draw(canvas, "RGBA")

    u = min(width, height)
    is_portrait = height > width
    pad_x = int(width * (0.10 if is_portrait else 0.14))
    content_w = width - 2 * pad_x
    center_x = width // 2
    center_y = int(height * (0.46 if is_portrait else 0.50))

    accent_rgb = _hex_to_rgb(spec.settings.accent_color)

    # Typography scaled off the shorter axis so 9:16, 1:1, and 16:9 stay balanced.
    badge_font = _load_font("Inter-Variable.ttf", int(u * 0.026), weight=700)
    cta_font = _load_font("Anton-Regular.ttf", int(u * (0.068 if is_portrait else 0.060)))
    title_font = _load_font("Inter-Variable.ttf", int(u * 0.030), weight=600)
    handle_font = _load_font("Inter-Variable.ttf", int(u * 0.034), weight=700)
    social_font = _load_font("Inter-Variable.ttf", int(u * 0.024), weight=500)

    # Prepare blocks and measure total height before drawing.
    cta_raw = (spec.settings.cta_text or "").strip() or _DEFAULT_CTA
    cta_lines = _wrap_text(cta_raw.upper(), cta_font, content_w, max_lines=3, ellipsis=True)
    cta_lh = _line_height(cta_font, factor=1.12)

    title_raw = (spec.video_title or "").strip() if spec.settings.show_video_title else ""
    title_box_pad_x = int(u * 0.036)
    title_box_pad_y = int(u * 0.024)
    title_lines = (
        _wrap_text(
            title_raw,
            title_font,
            max(80.0, content_w - 2 * title_box_pad_x),
            max_lines=2,
            ellipsis=True,
        )
        if title_raw
        else []
    )
    title_lh = _line_height(title_font, factor=1.24)

    yt_channel = spec.settings.youtube_handle.strip() or (spec.source_channel or "").strip()
    social_line = _social_footer_text(spec.settings)

    # Badge dimensions.
    badge_label = "YOUTUBE"
    badge_text_w = badge_font.getlength(badge_label)
    icon_w = int(u * 0.024)
    icon_gap = int(u * 0.016)
    badge_pad_x = int(u * 0.034)
    badge_h = int(u * 0.064)
    badge_w = int(badge_pad_x * 2 + icon_w + icon_gap + badge_text_w)

    gap_sm = int(u * 0.024)
    gap_md = int(u * 0.038)
    gap_lg = int(u * 0.048)

    total_h = badge_h + gap_md + len(cta_lines) * cta_lh
    title_box_h = 0
    if title_lines:
        title_box_h = len(title_lines) * title_lh + title_box_pad_y * 2
        total_h += gap_md + title_box_h
    if yt_channel:
        total_h += gap_md + _line_height(handle_font, factor=1.15)
    if social_line:
        total_h += gap_lg + _line_height(social_font, factor=1.15)

    y = max(int(height * 0.12), center_y - total_h // 2)

    # 1. YouTube red pill badge + crisp white play triangle.
    badge_left = center_x - badge_w // 2
    badge_box = [badge_left, y, badge_left + badge_w, y + badge_h]
    draw.rounded_rectangle(badge_box, radius=badge_h // 2, fill=(*accent_rgb, 245))

    tri_left = badge_left + badge_pad_x
    tri_h = int(badge_h * 0.38)
    tri_cy = y + badge_h // 2
    draw.polygon(
        [
            (tri_left, tri_cy - tri_h // 2),
            (tri_left, tri_cy + tri_h // 2),
            (tri_left + icon_w, tri_cy),
        ],
        fill=(255, 255, 255, 255),
    )
    draw.text(
        (tri_left + icon_w + icon_gap, tri_cy),
        badge_label,
        font=badge_font,
        fill=(255, 255, 255, 255),
        anchor="lm",
    )
    y += badge_h + gap_md

    # 2. Main CTA headline with soft drop shadow.
    shadow_offset = max(2, int(u * 0.004))
    for line in cta_lines:
        draw.text(
            (center_x, y + cta_lh // 2 + shadow_offset),
            line,
            font=cta_font,
            fill=(0, 0, 0, 150),
            anchor="mm",
        )
        draw.text(
            (center_x, y + cta_lh // 2),
            line,
            font=cta_font,
            fill=(255, 255, 255, 255),
            anchor="mm",
        )
        y += cta_lh

    # 3. Optional full YouTube video title card.
    if title_lines:
        y += gap_md
        max_line_w = max(title_font.getlength(line) for line in title_lines)
        box_w = min(content_w, int(max_line_w + title_box_pad_x * 2))
        box_left = center_x - box_w // 2
        draw.rounded_rectangle(
            [box_left, y, box_left + box_w, y + title_box_h],
            radius=int(u * 0.022),
            fill=(255, 255, 255, 26),
            outline=(255, 255, 255, 68),
            width=max(1, int(u * 0.002)),
        )
        ty = y + title_box_pad_y
        for line in title_lines:
            draw.text(
                (center_x, ty + title_lh // 2),
                line,
                font=title_font,
                fill=(248, 250, 252, 245),
                anchor="mm",
            )
            ty += title_lh
        y += title_box_h

    # 4. Channel / handle.
    if yt_channel:
        y += gap_md
        handle_lh = _line_height(handle_font, factor=1.15)
        draw.text(
            (center_x, y + handle_lh // 2),
            yt_channel,
            font=handle_font,
            fill=(255, 255, 255, 238),
            anchor="mm",
        )
        y += handle_lh

    # 5. Optional social handles footer.
    if social_line:
        y += gap_lg
        # Subtle divider line above social footer.
        div_w = int(u * 0.14)
        draw.line(
            [(center_x - div_w // 2, y - gap_sm), (center_x + div_w // 2, y - gap_sm)],
            fill=(255, 255, 255, 65),
            width=max(1, int(u * 0.002)),
        )
        social_lh = _line_height(social_font, factor=1.15)
        draw.text(
            (center_x, y + social_lh // 2),
            social_line,
            font=social_font,
            fill=(203, 213, 225, 225),
            anchor="mm",
        )

    return canvas


def write_outro_card(path: Path, spec: OutroCardSpec, *, width: int, height: int) -> Path:
    """Render and persist an outro card PNG to ``path``."""
    path.parent.mkdir(parents=True, exist_ok=True)
    image = render_outro_card(spec, width=width, height=height)
    image.save(path, format="PNG")
    return path


def render_outro_preview_png(spec: OutroCardSpec, *, width: int, height: int) -> bytes:
    """Render a realistic preview PNG (card composited over a soft blurred-look studio backdrop)."""
    backdrop = Image.new("RGBA", (width, height))
    # Subtle warm-to-slate diagonal tone so the dark scrim translucency is visible in Settings.
    cols = Image.new("RGBA", (64, 64))
    data = []
    for py in range(64):
        for px in range(64):
            r = int(42 + (px / 63) * 34 + (py / 63) * 18)
            g = int(46 + (px / 63) * 24 + (py / 63) * 20)
            b = int(58 + (1 - px / 63) * 38)
            data.append((r, g, b, 255))
    cols.putdata(data)
    backdrop = cols.resize((width, height), Image.Resampling.BILINEAR)

    card = render_outro_card(spec, width=width, height=height)
    composited = Image.alpha_composite(backdrop, card).convert("RGB")
    buf = BytesIO()
    composited.save(buf, format="PNG")
    return buf.getvalue()
