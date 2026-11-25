"""Outro CTA card renderer — YouTube Search Bar overlays composited over a live-blurred tail.

Generates ratio-aware (9:16, 1:1, 16:9) YouTube bridge overlays using Pillow
and AutoClip's bundled fonts (Anton + Inter), staying inside cross-platform
TikTok / Instagram Reels / YouTube Shorts safe zones.
"""

from __future__ import annotations

import contextlib
from collections.abc import Callable
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from ..config import OutroSettings
from .captions import FONT_DIR

#: Smooth alpha fade-in length for the blurred tail + CTA overlay.
OUTRO_FADE_S: float = 0.35
#: Smooth cubic ease-out slide-up duration for the CTA foreground.
OUTRO_SLIDE_S: float = 0.45
#: Skip the outro if clamping to MAX_CLIP_FRACTION leaves less than this.
MIN_EFFECTIVE_OUTRO_S: float = 0.5
#: Never cover more than 40% of a clip with the outro overlay.
MAX_CLIP_FRACTION: float = 0.4

_DEFAULT_CTA = "Tonton selengkapnya di YouTube"
_GOLD_ACCENT = (255, 214, 10, 255)


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


def _overlay_draw(
    canvas: Image.Image, fn: Callable[[ImageDraw.ImageDraw], object]
) -> Image.Image:
    """Alpha-composite translucent shapes onto ``canvas`` without overwriting its alpha."""
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    fn(ImageDraw.Draw(layer, "RGBA"))
    return Image.alpha_composite(canvas, layer)


def _add_ambient_glow(
    canvas: Image.Image,
    cx: int,
    cy: int,
    rx: int,
    ry: int,
    rgba: tuple[int, int, int, int],
    *,
    blur_radius: int,
) -> Image.Image:
    glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(glow, "RGBA").ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=rgba)
    glow = glow.filter(ImageFilter.GaussianBlur(radius=max(4, blur_radius)))
    return Image.alpha_composite(canvas, glow)


def _add_shadow(
    canvas: Image.Image,
    box: list[int],
    *,
    radius: int,
    blur: int,
    offset_y: int,
    alpha: int = 160,
) -> Image.Image:
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    x0, y0, x1, y1 = box
    ImageDraw.Draw(shadow, "RGBA").rounded_rectangle(
        [x0, y0 + offset_y, x1, y1 + offset_y],
        radius=radius,
        fill=(0, 0, 0, alpha),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=max(2, blur)))
    return Image.alpha_composite(canvas, shadow)


def _draw_yt_icon(size: int, rgb: tuple[int, int, int]) -> Image.Image:
    """3x-supersampled YouTube rounded-rectangle play icon."""
    s = 3
    w, h = max(12, int(size * 1.42)), max(8, size)
    im = Image.new("RGBA", (w * s, h * s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im, "RGBA")
    d.rounded_rectangle([0, 0, w * s - 1, h * s - 1], radius=int(h * s * 0.28), fill=(*rgb, 255))
    cx, cy = w * s // 2, h * s // 2
    tri_h = int(h * s * 0.42)
    tri_w = int(tri_h * 0.88)
    nudge = max(2, int(w * s * 0.03))
    d.polygon(
        [
            (cx - tri_w // 2 + nudge, cy - tri_h // 2),
            (cx - tri_w // 2 + nudge, cy + tri_h // 2),
            (cx + tri_w // 2 + nudge, cy),
        ],
        fill=(255, 255, 255, 255),
    )
    return im.resize((w, h), Image.Resampling.LANCZOS)


def _draw_search_icon(size: int, rgba: tuple[int, int, int, int]) -> Image.Image:
    """3x-supersampled magnifying glass icon."""
    s = 3
    sz = max(12, size) * s
    im = Image.new("RGBA", (sz, sz), (0, 0, 0, 0))
    d = ImageDraw.Draw(im, "RGBA")
    lw = max(4, int(sz * 0.10))
    r = int(sz * 0.30)
    cx, cy = int(sz * 0.43), int(sz * 0.43)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=rgba, width=lw)
    d.line(
        [(cx + int(r * 0.72), cy + int(r * 0.72)), (int(sz * 0.86), int(sz * 0.86))],
        fill=rgba,
        width=lw,
    )
    return im.resize((max(12, size), max(12, size)), Image.Resampling.LANCZOS)


def _draw_ig_icon(size: int, rgba: tuple[int, int, int, int]) -> Image.Image:
    """3x-supersampled Instagram camera glyph."""
    s = 3
    sz = max(12, size) * s
    im = Image.new("RGBA", (sz, sz), (0, 0, 0, 0))
    d = ImageDraw.Draw(im, "RGBA")
    pad = max(3, int(sz * 0.06))
    lw = max(3, int(sz * 0.085))
    d.rounded_rectangle(
        [pad, pad, sz - pad, sz - pad],
        radius=int(sz * 0.28),
        outline=rgba,
        width=lw,
    )
    cx, cy = sz // 2, sz // 2
    r = int(sz * 0.22)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=rgba, width=lw)
    dot_r = max(2, int(sz * 0.055))
    dx, dy = int(sz * 0.74), int(sz * 0.26)
    d.ellipse([dx - dot_r, dy - dot_r, dx + dot_r, dy + dot_r], fill=rgba)
    return im.resize((max(12, size), max(12, size)), Image.Resampling.LANCZOS)


def _draw_tiktok_icon(size: int, rgba: tuple[int, int, int, int]) -> Image.Image:
    """3x-supersampled TikTok musical note glyph."""
    s = 3
    sz = max(12, size) * s
    im = Image.new("RGBA", (sz, sz), (0, 0, 0, 0))
    d = ImageDraw.Draw(im, "RGBA")
    lw = max(4, int(sz * 0.11))
    stem_x = int(sz * 0.56)
    d.line([(stem_x, int(sz * 0.16)), (stem_x, int(sz * 0.68))], fill=rgba, width=lw)
    d.line([(stem_x, int(sz * 0.18)), (int(sz * 0.80), int(sz * 0.30))], fill=rgba, width=lw)
    r = int(sz * 0.20)
    cx, cy = int(sz * 0.40), int(sz * 0.69)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=rgba, width=lw)
    return im.resize((max(12, size), max(12, size)), Image.Resampling.LANCZOS)


def _format_handle(raw: str) -> str:
    cleaned = raw.strip()
    if not cleaned:
        return ""
    return cleaned if cleaned.startswith("@") else f"@{cleaned}"


def _truncate_to_width(line: str, font: ImageFont.FreeTypeFont, max_width: float) -> str:
    text = line.rstrip(" .,;:-–—")
    while text and font.getlength(text + "…") > max_width:
        text = text[:-1].rstrip()
    return (text + "…") if text else "…"


def _wrap_text(
    text: str,
    font: ImageFont.FreeTypeFont,
    max_width: float,
    *,
    max_lines: int,
    ellipsis: bool = True,
) -> list[str]:
    """Word-wrap text to pixel width, truncating cleanly on overflow."""
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
                if ellipsis:
                    lines[-1] = _truncate_to_width(lines[-1], font, max_width)
                return lines
            current = _fit_single_word(word)
        else:
            lines.append(_fit_single_word(word))
            if len(lines) == max_lines:
                return lines
            current = ""

        if idx == len(words) - 1 and current:
            lines.append(current)
            return lines[:max_lines]

    if current:
        lines.append(current)
    return lines[:max_lines]


def _line_height(font: ImageFont.FreeTypeFont, factor: float = 1.15) -> int:
    ascent, descent = font.getmetrics()
    return max(1, int((ascent + descent) * factor))


def _make_scrim(width: int, height: int) -> Image.Image:
    """Translucent dark vertical scrim preserving live-blurred motion underneath."""
    column = Image.new("RGBA", (1, height))
    pixels = []
    for y in range(height):
        norm = abs((y / max(1, height - 1)) - 0.45) * 2.0
        alpha = int(162 - min(1.0, norm) * 40)
        pixels.append((8, 10, 16, alpha))
    column.putdata(pixels)
    return column.resize((width, height), Image.Resampling.BILINEAR)


def _social_items(settings: OutroSettings, icon_sz: int) -> list[tuple[Image.Image, str]]:
    items: list[tuple[Image.Image, str]] = []
    ig = _format_handle(settings.instagram_handle)
    tt = _format_handle(settings.tiktok_handle)
    rgba = (248, 250, 252, 240)
    if ig:
        items.append((_draw_ig_icon(icon_sz, rgba), ig))
    if tt:
        items.append((_draw_tiktok_icon(icon_sz, rgba), tt))
    return items


def render_outro_card(
    spec: OutroCardSpec,
    *,
    width: int,
    height: int,
    include_scrim: bool = True,
) -> Image.Image:
    """Render the YouTube Search Bar CTA overlay sized to ``(width, height)``.

    When ``include_scrim`` is False, only the transparent foreground (glow +
    search bar + typography + social pills) is rendered so FFmpeg can animate
    a smooth slide-up over an independently darkened live-blurred background.
    """
    canvas = (
        _make_scrim(width, height)
        if include_scrim
        else Image.new("RGBA", (width, height), (0, 0, 0, 0))
    )

    is_portrait = height > width
    is_square = height == width
    # Scale unit tuned per aspect ratio so 9:16, 1:1, and 16:9 all feel proportional.
    u = float(width) if is_portrait else float(height) * (0.86 if is_square else 0.88)

    center_x = width // 2
    # 9:16 sits slightly above vertical center to stay inside the TikTok/Reels/Shorts safe zone.
    center_y = int(height * (0.43 if is_portrait else 0.50))

    accent_rgb = _hex_to_rgb(spec.settings.accent_color)

    # Typography
    yt_font = _load_font("Inter-Variable.ttf", int(u * 0.041), weight=800)
    cta_font = _load_font("Anton-Regular.ttf", int(u * (0.082 if is_portrait else 0.078)))
    query_font = _load_font("Inter-Variable.ttf", int(u * 0.031), weight=700)
    title_font = _load_font("Inter-Variable.ttf", int(u * 0.028), weight=600)
    cue_font = _load_font("Inter-Variable.ttf", int(u * 0.024), weight=700)
    follow_font = _load_font("Inter-Variable.ttf", int(u * 0.020), weight=600)
    pill_font = _load_font("Inter-Variable.ttf", int(u * 0.025), weight=600)

    # Bar & content widths (respecting safe margins on 9:16)
    bar_w = int(width * 0.76) if is_portrait else min(int(width * 0.76), int(u * 0.86))
    bar_h = max(44, int(u * 0.092))
    content_w = bar_w

    # Prepare text blocks
    cta_raw = (spec.settings.cta_text or "").strip() or _DEFAULT_CTA
    cta_lines = _wrap_text(cta_raw.upper(), cta_font, content_w, max_lines=3, ellipsis=True)
    cta_lh = _line_height(cta_font, factor=1.08)

    search_query = (
        spec.settings.youtube_handle.strip()
        or (spec.source_channel or "").strip()
        or "YouTube"
    )

    title_raw = (spec.video_title or "").strip() if spec.settings.show_video_title else ""
    title_lines = (
        _wrap_text(f"“{title_raw}”", title_font, int(content_w * 0.96), max_lines=2, ellipsis=True)
        if title_raw
        else []
    )
    title_lh = _line_height(title_font, factor=1.24)
    cue_text = (
        "Link video full di bio / deskripsi  →"
        if title_lines
        else "Cari channel di atas  ·  atau klik link di bio  →"
    )
    cue_color = _GOLD_ACCENT if title_lines else (226, 232, 240, 232)

    icon_sz = max(14, int(u * 0.024))
    socials = _social_items(spec.settings, icon_sz)

    # Measure total vertical height before drawing
    yt_icon_h = max(24, int(u * 0.054))
    yt_icon = _draw_yt_icon(yt_icon_h, accent_rgb)
    gap_xs = int(u * 0.022)
    gap_sm = int(u * 0.032)
    gap_md = int(u * 0.044)
    cue_lh = _line_height(cue_font, factor=1.18)
    follow_lh = _line_height(follow_font, factor=1.18)
    pill_h = max(32, int(u * 0.054))

    total_h = yt_icon_h + gap_sm + len(cta_lines) * cta_lh + gap_md + bar_h
    if title_lines:
        total_h += gap_sm + len(title_lines) * title_lh + gap_xs + cue_lh
    else:
        total_h += gap_sm + cue_lh
    if socials:
        total_h += gap_sm + gap_xs + follow_lh + gap_xs + pill_h

    start_y = max(int(height * 0.14), center_y - total_h // 2)

    # Ambient warm-red glow anchored behind headline & search bar
    glow_cy = start_y + int(total_h * 0.42)
    canvas = _add_ambient_glow(
        canvas,
        center_x,
        glow_cy,
        rx=int(bar_w * 0.54),
        ry=int(total_h * 0.42),
        rgba=(*accent_rgb, 88),
        blur_radius=int(u * 0.088),
    )

    y = start_y

    # 1. YouTube Logo Lockup
    yt_label = "YouTube"
    lock_gap = int(u * 0.016)
    lock_w = yt_icon.width + lock_gap + int(yt_font.getlength(yt_label))
    lx = center_x - lock_w // 2
    canvas.alpha_composite(yt_icon, (lx, y))
    lock_y = y
    canvas = _overlay_draw(
        canvas,
        lambda d: d.text(
            (lx + yt_icon.width + lock_gap, lock_y + yt_icon.height // 2),
            yt_label,
            font=yt_font,
            fill=(255, 255, 255, 252),
            anchor="lm",
        ),
    )
    y += yt_icon_h + gap_sm

    # 2. Dual-Tone Bold Headline (last line pops in gold when 2+ lines)
    shadow_dy = max(2, int(u * 0.004))
    head_y = y

    def _draw_headline(d: ImageDraw.ImageDraw) -> None:
        cy = head_y
        for idx, line in enumerate(cta_lines):
            is_accent_line = len(cta_lines) > 1 and idx == len(cta_lines) - 1
            fill = _GOLD_ACCENT if is_accent_line else (255, 255, 255, 255)
            d.text(
                (center_x, cy + cta_lh // 2 + shadow_dy),
                line,
                font=cta_font,
                fill=(0, 0, 0, 155),
                anchor="mm",
            )
            d.text((center_x, cy + cta_lh // 2), line, font=cta_font, fill=fill, anchor="mm")
            cy += cta_lh

    canvas = _overlay_draw(canvas, _draw_headline)
    y += len(cta_lines) * cta_lh + gap_md

    # 3. Elevated White YouTube Search Bar
    bx0, by0 = center_x - bar_w // 2, y
    bar_r = bar_h // 2
    canvas = _add_shadow(
        canvas,
        [bx0, by0, bx0 + bar_w, by0 + bar_h],
        radius=bar_r,
        blur=int(u * 0.032),
        offset_y=int(u * 0.014),
        alpha=165,
    )

    search_left_sz = max(18, int(bar_h * 0.38))
    search_right_sz = max(18, int(bar_h * 0.36))
    rb_w = int(bar_h * 1.18)
    rb_pad = max(5, int(bar_h * 0.10))
    text_left = bx0 + int(bar_h * 0.36) + search_left_sz + int(bar_h * 0.20)
    max_q_w = (bx0 + bar_w - rb_w - rb_pad * 2) - text_left - int(bar_h * 0.16)
    shown_query = (
        _truncate_to_width(search_query, query_font, max_q_w)
        if query_font.getlength(search_query) > max_q_w
        else search_query
    )
    cursor_x = text_left + int(query_font.getlength(shown_query)) + max(4, int(u * 0.007))
    cursor_w = max(2, int(u * 0.004))

    def _draw_bar(d: ImageDraw.ImageDraw) -> None:
        d.rounded_rectangle(
            [bx0, by0, bx0 + bar_w, by0 + bar_h],
            radius=bar_r,
            fill=(252, 253, 255, 252),
        )
        d.text(
            (text_left, by0 + bar_h // 2),
            shown_query,
            font=query_font,
            fill=(15, 23, 42, 250),
            anchor="lm",
        )
        d.rectangle(
            [cursor_x, by0 + int(bar_h * 0.25), cursor_x + cursor_w, by0 + int(bar_h * 0.75)],
            fill=(*accent_rgb, 245),
        )
        d.rounded_rectangle(
            [bx0 + bar_w - rb_w - rb_pad, by0 + rb_pad, bx0 + bar_w - rb_pad, by0 + bar_h - rb_pad],
            radius=(bar_h - rb_pad * 2) // 2,
            fill=(*accent_rgb, 255),
        )

    canvas = _overlay_draw(canvas, _draw_bar)
    canvas.alpha_composite(
        _draw_search_icon(search_left_sz, (15, 23, 42, 215)),
        (bx0 + int(bar_h * 0.36), by0 + (bar_h - search_left_sz) // 2),
    )
    canvas.alpha_composite(
        _draw_search_icon(search_right_sz, (255, 255, 255, 255)),
        (
            bx0 + bar_w - rb_w - rb_pad + (rb_w - search_right_sz) // 2,
            by0 + (bar_h - search_right_sz) // 2,
        ),
    )
    y += bar_h + gap_sm

    # 4. Optional Clean Floating Video Title (Revisi 2A) + Cue
    below_y = y

    def _draw_below(d: ImageDraw.ImageDraw) -> None:
        cy = below_y
        for line in title_lines:
            d.text(
                (center_x, cy + title_lh // 2),
                line,
                font=title_font,
                fill=(241, 245, 249, 240),
                anchor="mm",
            )
            cy += title_lh
        if title_lines:
            cy += gap_xs
        d.text((center_x, cy + cue_lh // 2), cue_text, font=cue_font, fill=cue_color, anchor="mm")

    canvas = _overlay_draw(canvas, _draw_below)
    y += (len(title_lines) * title_lh + gap_xs if title_lines else 0) + cue_lh

    # 5. Optional Social Icon Pills (IG / TikTok)
    if socials:
        div_y = y + gap_sm
        follow_y = div_y + gap_xs
        pills_cy = follow_y + follow_lh + gap_xs + pill_h // 2
        div_half = int(u * 0.07)

        canvas = _overlay_draw(
            canvas,
            lambda d: (
                d.line(
                    [(center_x - div_half, div_y), (center_x + div_half, div_y)],
                    fill=(255, 255, 255, 62),
                    width=max(1, int(u * 0.002)),
                ),
                d.text(
                    (center_x, follow_y + follow_lh // 2),
                    "FOLLOW JUGA DI",
                    font=follow_font,
                    fill=(180, 192, 210, 215),
                    anchor="mm",
                ),
            ),
        )

        pill_pad_x = int(u * 0.026)
        pill_gap = int(u * 0.018)
        icon_gap = int(u * 0.013)
        widths = [
            pill_pad_x * 2 + icon_sz + icon_gap + int(pill_font.getlength(txt))
            for _, txt in socials
        ]
        total_pills_w = sum(widths) + pill_gap * (len(socials) - 1)
        px = center_x - total_pills_w // 2
        for (icon, txt), pw in zip(socials, widths, strict=True):
            x_cur = px
            canvas = _overlay_draw(
                canvas,
                lambda d, x_cur=x_cur, pw=pw: d.rounded_rectangle(
                    [x_cur, pills_cy - pill_h // 2, x_cur + pw, pills_cy + pill_h // 2],
                    radius=pill_h // 2,
                    fill=(255, 255, 255, 26),
                    outline=(255, 255, 255, 66),
                    width=max(1, int(u * 0.002)),
                ),
            )
            canvas.alpha_composite(icon, (x_cur + pill_pad_x, pills_cy - icon_sz // 2))
            canvas = _overlay_draw(
                canvas,
                lambda d, x_cur=x_cur, txt=txt: d.text(
                    (x_cur + pill_pad_x + icon_sz + icon_gap, pills_cy),
                    txt,
                    font=pill_font,
                    fill=(241, 245, 249, 242),
                    anchor="lm",
                ),
            )
            px += pw + pill_gap

    return canvas


def write_outro_card(
    path: Path,
    spec: OutroCardSpec,
    *,
    width: int,
    height: int,
    include_scrim: bool = False,
) -> Path:
    """Render and persist an outro card PNG to ``path``.

    Defaults to ``include_scrim=False`` so FFmpeg can animate a slide-up over
    an independently darkened live-blurred video tail without exposing edges.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    image = render_outro_card(spec, width=width, height=height, include_scrim=include_scrim)
    image.save(path, format="PNG")
    return path


def render_outro_preview_png(spec: OutroCardSpec, *, width: int, height: int) -> bytes:
    """Render a realistic WYSIWYG preview PNG composited over a soft blurred-studio backdrop."""
    sw, sh = max(32, width // 4), max(32, height // 4)
    small = Image.new("RGBA", (sw, sh), (16, 19, 30, 255))
    small = _overlay_draw(
        small,
        lambda d: (
            d.ellipse([-sw * 0.15, sh * 0.04, sw * 0.85, sh * 0.68], fill=(155, 80, 48, 170)),
            d.ellipse([sw * 0.28, sh * 0.14, sw * 1.18, sh * 0.80], fill=(38, 86, 155, 180)),
            d.ellipse([sw * 0.70, sh * 0.12, sw * 0.92, sh * 0.25], fill=(250, 175, 88, 130)),
        ),
    )
    backdrop = small.filter(ImageFilter.GaussianBlur(radius=14)).resize(
        (width, height), Image.Resampling.BICUBIC
    )

    card = render_outro_card(spec, width=width, height=height, include_scrim=True)
    composited = Image.alpha_composite(backdrop, card).convert("RGB")
    buf = BytesIO()
    composited.save(buf, format="PNG")
    return buf.getvalue()
