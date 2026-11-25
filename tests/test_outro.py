"""Unit tests for the Pillow outro CTA card generator."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path

import pytest
from autoclip.config import OutroSettings
from autoclip.pipeline import outro
from PIL import Image


def test_effective_outro_duration_clamps_and_skips() -> None:
    assert outro.effective_outro_duration(3.0, 30.0) == pytest.approx(3.0)
    # 40% cap on a 5s clip -> 2.0s
    assert outro.effective_outro_duration(3.0, 5.0) == pytest.approx(2.0)
    # 40% of 1.0s is 0.4s < 0.5s minimum -> skip cleanly
    assert outro.effective_outro_duration(3.0, 1.0) == 0.0
    assert outro.effective_outro_duration(3.0, 0.0) == 0.0


@pytest.mark.parametrize(
    ("width", "height"),
    [(1080, 1920), (1080, 1080), (1920, 1080)],
)
def test_renders_all_ratios_as_rgba_with_scrim_and_card(width: int, height: int) -> None:
    spec = outro.OutroCardSpec(
        settings=OutroSettings(
            enabled=True,
            youtube_handle="@ChannelTest",
            instagram_handle="igtest",
            tiktok_handle="@tiktoktest",
        ),
        video_title="Podcast Episode 42 — Cara Bangun Bisnis Dari Nol",
        source_channel="Fallback Channel",
    )

    image = outro.render_outro_card(spec, width=width, height=height)

    assert image.mode == "RGBA"
    assert image.size == (width, height)

    # Edge pixels have a translucent dark scrim (not fully transparent, not opaque).
    edge_r, edge_g, edge_b, edge_a = image.getpixel((10, 10))
    assert 80 <= edge_a <= 220
    assert edge_r < 40 and edge_g < 40 and edge_b < 40

    # Accent red pixels (YouTube badge) must appear somewhere on the canvas.
    pixels = image.getdata()
    has_red_accent = any(r > 200 and g < 60 and b < 80 and a > 200 for r, g, b, a in pixels)
    assert has_red_accent


def test_long_unicode_title_and_empty_handles_do_not_crash() -> None:
    long_title = (
        "Episode Spesial #99: Diskusi Panjang Tentang Strategi Konten Pendek Untuk "
        "YouTube Shorts, Instagram Reels, dan TikTok di Tahun 2026 — Jangan Sampai Kelewatan!"
    )
    spec = outro.OutroCardSpec(
        settings=OutroSettings(
            enabled=True,
            cta_text="Tonton selengkapnya di YouTube",
            youtube_handle="",
            show_video_title=True,
            instagram_handle="",
            tiktok_handle="",
        ),
        video_title=long_title,
        source_channel=None,
    )

    image = outro.render_outro_card(spec, width=1080, height=1920)
    assert image.size == (1080, 1920)
    assert image.mode == "RGBA"


def test_youtube_handle_prefers_settings_over_source_channel_and_respects_show_title() -> None:
    with_custom = outro.render_outro_card(
        outro.OutroCardSpec(
            settings=OutroSettings(enabled=True, youtube_handle="@CustomHandle"),
            video_title="Video Title",
            source_channel="FallbackCh",
        ),
        width=1080,
        height=1920,
    )
    with_fallback = outro.render_outro_card(
        outro.OutroCardSpec(
            settings=OutroSettings(enabled=True, youtube_handle=""),
            video_title="Video Title",
            source_channel="FallbackCh",
        ),
        width=1080,
        height=1920,
    )
    without_title = outro.render_outro_card(
        outro.OutroCardSpec(
            settings=OutroSettings(
                enabled=True, youtube_handle="@CustomHandle", show_video_title=False
            ),
            video_title="Video Title",
            source_channel="FallbackCh",
        ),
        width=1080,
        height=1920,
    )

    assert with_custom.tobytes() != with_fallback.tobytes()
    assert with_custom.tobytes() != without_title.tobytes()


def test_write_outro_card_and_preview_png_bytes(tmp_path: Path) -> None:
    spec = outro.OutroCardSpec(
        settings=OutroSettings(enabled=True, youtube_handle="@PreviewCh"),
        video_title="Sample Full Video",
    )

    saved = outro.write_outro_card(tmp_path / "outro.png", spec, width=1080, height=1920)
    assert saved.exists()
    assert saved.read_bytes()[:4] == b"\x89PNG"

    preview_bytes = outro.render_outro_preview_png(spec, width=540, height=960)
    assert preview_bytes[:4] == b"\x89PNG"
    opened = Image.open(BytesIO(preview_bytes))
    assert opened.size == (540, 960)
