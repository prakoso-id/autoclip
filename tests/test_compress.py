"""Tests for visually lossless H.264 video compression."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from autoclip import app as app_module
from autoclip.app import create_app
from autoclip.pipeline import ffmpeg
from autoclip.pipeline.compress import compress_video
from fastapi.testclient import TestClient


@pytest.fixture
def client(autoclip_home, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv(app_module.ENV_NO_WORKER, "1")
    with TestClient(create_app()) as test_client:
        yield test_client


def _make_sample_video(path: Path) -> Path:
    ffmpeg.run(
        [
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=1.5:size=320x180:rate=24",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=1.5",
            "-c:v",
            "libx264",
            "-crf",
            "10",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            str(path),
        ]
    )
    return path


def test_compress_video_reduces_high_bitrate_sample(tmp_path: Path) -> None:
    src = _make_sample_video(tmp_path / "sample.mp4")
    dst = tmp_path / "sample_compressed.mp4"

    result = compress_video(src, dst, crf=24, prefer_hardware_encoder=False)

    assert result.output == dst
    assert dst.is_file()
    assert result.original_bytes > 0
    assert result.compressed_bytes > 0
    assert result.compressed_bytes < result.original_bytes
    assert result.saved_percent > 0


def test_compress_api_round_trip(client: TestClient, tmp_path: Path) -> None:
    src = _make_sample_video(tmp_path / "clip.mp4")

    with src.open("rb") as fh:
        res = client.post(
            "/api/compress",
            files={"file": ("my clip.mp4", fh, "video/mp4")},
            data={"crf": "23"},
        )

    assert res.status_code == 201
    body = res.json()
    assert body["filename"] == "my-clip_compressed.mp4"
    assert body["original_bytes"] == src.stat().st_size
    assert body["compressed_bytes"] > 0
    assert body["download_url"] == f"/api/compress/{body['id']}/download"

    dl = client.get(body["download_url"])
    assert dl.status_code == 200
    assert dl.headers["content-type"] == "video/mp4"
    assert len(dl.content) == body["compressed_bytes"]


def test_compress_api_rejects_out_of_range_crf(client: TestClient, tmp_path: Path) -> None:
    dummy = tmp_path / "dummy.mp4"
    dummy.write_bytes(b"not-a-video")

    with dummy.open("rb") as fh:
        res = client.post(
            "/api/compress",
            files={"file": ("dummy.mp4", fh, "video/mp4")},
            data={"crf": "50"},
        )

    assert res.status_code == 400


@pytest.mark.parametrize("bad_id", ["../etc", "nonexistent1234"])
def test_download_missing_or_invalid_id_is_404(client: TestClient, bad_id: str) -> None:
    res = client.get(f"/api/compress/{bad_id}/download")
    assert res.status_code == 404
