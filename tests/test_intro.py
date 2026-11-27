"""Unit tests for Minimalist Floating Intro Hook & Channel Watermark overlays."""

from __future__ import annotations

from pathlib import Path

import pytest
from autoclip.config import IntroSettings
from autoclip.pipeline import intro


def test_effective_intro_duration_clamps_and_skips() -> None:
    assert intro.effective_intro_duration(3.0, 20.0) == pytest.approx(3.0)
    assert intro.effective_intro_duration(3.0, 5.0) == pytest.approx(2.0)
    assert intro.effective_intro_duration(3.0, 1.0) == 0.0


@pytest.mark.parametrize(("width", "height"), [(1080, 1920), (1080, 1080), (1920, 1080)])
def test_renders_minimalist_floating_intro_across_ratios(width: int, height: int) -> None:
    spec = intro.IntroHookSpec(text="Kenapa Judulnya Giant Killing?", duration_s=3.0)
    img = intro.render_intro_hook(spec, width=width, height=height)

    assert img.mode == "RGBA"
    assert img.size == (width, height)
    # Bottom half must stay completely transparent so speaker & captions are untouched.
    assert img.getpixel((width // 2, int(height * 0.75)))[3] == 0
    # Red accent underline must be present in upper region.
    top_crop = img.crop((0, 0, width, int(height * 0.45)))
    has_red = any(r > 200 and g < 60 and b < 80 and a > 180 for r, g, b, a in top_crop.getdata())
    assert has_red


def test_renders_watermark_in_top_safe_zone(tmp_path: Path) -> None:
    spec = intro.WatermarkSpec(text="@ObrolanTibatiba")
    saved = intro.write_watermark(tmp_path / "wm.png", spec, width=1080, height=1920)
    assert saved.exists()
    assert saved.read_bytes()[:4] == b"\x89PNG"

    img = intro.render_watermark(spec, width=1080, height=1920)
    assert img.mode == "RGBA"
    assert img.getpixel((540, 1400))[3] == 0
    top_band = img.crop((200, 140, 880, 260))
    has_bright = any(
        r > 200 and g > 200 and b > 200 and a > 120 for r, g, b, a in top_band.getdata()
    )
    assert has_bright


def test_intro_settings_defaults_and_validation() -> None:
    from pydantic import ValidationError

    s = IntroSettings()
    assert s.enabled is False
    assert s.duration_s == 3.0
    assert s.watermark_enabled is False
    assert s.watermark_text == ""

    with pytest.raises(ValidationError):
        IntroSettings(duration_s=0.3)
    with pytest.raises(ValidationError):
        IntroSettings(duration_s=12.0)


def test_filtergraph_wires_intro_watermark_and_outro_together(tmp_path: Path) -> None:
    from autoclip.config import OutroSettings
    from autoclip.pipeline import captions, export, outro
    from autoclip.pipeline.reframe.croppath import centre_crop

    req = export.ExportRequest(
        source=tmp_path / "src.mp4",
        destination=tmp_path / "dst.mp4",
        start_s=0.0,
        end_s=10.0,
        crop_path=centre_crop(1280, 720, 10.0),
        words=[],
        style=captions.get_style("bold_pop"),
        burn_captions=False,
        outro=outro.OutroCardSpec(settings=OutroSettings(enabled=True, duration_s=3.0)),
        watermark=intro.WatermarkSpec(text="@ObrolanTibatiba"),
        intro_hook=intro.IntroHookSpec(text="Kenapa Judulnya Giant Killing?", duration_s=3.0),
    )

    graph = export.build_video_filtergraph(
        req,
        subtitle_name=None,
        outro_input_index=1,
        watermark_input_index=2,
        intro_input_index=3,
    )
    assert "[2:v]overlay=0:0" in graph
    assert "[3:v]format=rgba" in graph
    assert "enable='lte(t,3.0000)'" in graph
    assert "enable='gte(t,7.0000)':eof_action=repeat" in graph
    assert "[vout]" in graph
