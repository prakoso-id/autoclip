"""Visually lossless H.264 video compression via FFmpeg."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from ..config import ExportSettings
from . import export, ffmpeg

log = logging.getLogger(__name__)

DEFAULT_COMPRESS_CRF = 23
COMPRESS_AUDIO_BITRATE = "128k"


class CompressError(RuntimeError):
    """Compressing a video failed."""


@dataclass(frozen=True)
class CompressResult:
    output: Path
    original_bytes: int
    compressed_bytes: int

    @property
    def saved_bytes(self) -> int:
        return max(0, self.original_bytes - self.compressed_bytes)

    @property
    def saved_percent(self) -> float:
        if self.original_bytes <= 0:
            return 0.0
        return round((self.saved_bytes / self.original_bytes) * 100.0, 1)


def compress_video(
    source: Path,
    destination: Path,
    *,
    crf: int = DEFAULT_COMPRESS_CRF,
    prefer_hardware_encoder: bool = True,
) -> CompressResult:
    """Re-encode ``source`` to a visually lossless H.264 MP4 at ``destination``.

    Preserves native resolution and frame rate while stripping excess bitrate
    for social media, messaging, and archival sharing.
    """
    if not source.exists():
        raise CompressError(f"Source file not found: {source}")

    original_bytes = source.stat().st_size
    settings = ExportSettings(crf=crf, prefer_hardware_encoder=prefer_hardware_encoder)
    destination.parent.mkdir(parents=True, exist_ok=True)

    def _build_args(hw_decode: list[str]) -> list[str]:
        return [
            *hw_decode,
            "-i",
            str(source),
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            *export.encoder_args(settings),
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            COMPRESS_AUDIO_BITRATE,
            "-movflags",
            "+faststart",
            str(destination),
        ]

    hw_decode = export.decoder_args(settings)
    try:
        ffmpeg.run(_build_args(hw_decode))
    except ffmpeg.FFmpegError as exc:
        if hw_decode:
            log.warning(
                "CUDA hwaccel decode failed for %s (%s); retrying with software decode.",
                source.name,
                exc,
            )
            try:
                ffmpeg.run(_build_args([]))
            except ffmpeg.FFmpegError as retry_exc:
                raise CompressError(
                    f"Could not compress {source.name}.\n{retry_exc}"
                ) from retry_exc
        else:
            raise CompressError(f"Could not compress {source.name}.\n{exc}") from exc

    if not destination.exists() or destination.stat().st_size == 0:
        raise CompressError(f"ffmpeg reported success but {destination.name} is empty.")

    compressed_bytes = destination.stat().st_size
    log.info(
        "Compressed %s: %.1f MB -> %.1f MB (saved %.1f%%)",
        source.name,
        original_bytes / (1024 * 1024),
        compressed_bytes / (1024 * 1024),
        ((original_bytes - compressed_bytes) / original_bytes * 100.0) if original_bytes else 0.0,
    )
    return CompressResult(
        output=destination,
        original_bytes=original_bytes,
        compressed_bytes=compressed_bytes,
    )
