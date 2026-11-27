"""Standalone visually lossless H.264 video compression endpoints."""

from __future__ import annotations

import asyncio
import re
import shutil
from pathlib import Path

from fastapi import APIRouter, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import paths
from ..config import load as load_settings
from ..db.models import new_id
from ..pipeline.compress import DEFAULT_COMPRESS_CRF, CompressError, compress_video

router = APIRouter(prefix="/api/compress", tags=["compress"])

_SAFE_STEM_RE = re.compile(r"[^a-zA-Z0-9._-]+")
_ALLOWED_ID_RE = re.compile(r"^[a-f0-9]{8,32}$")


class CompressOut(BaseModel):
    id: str
    filename: str
    original_bytes: int
    compressed_bytes: int
    saved_bytes: int
    saved_percent: float
    download_url: str


def _safe_stem(filename: str | None) -> str:
    stem = Path(filename or "video").stem
    cleaned = _SAFE_STEM_RE.sub("-", stem).strip("-.")
    return (cleaned[:80] or "video")


@router.post("", response_model=CompressOut, status_code=201)
async def compress_upload(
    file: UploadFile,
    crf: int = Form(default=DEFAULT_COMPRESS_CRF),
) -> CompressOut:
    """Upload a video and compress it to a visually lossless H.264 MP4."""
    if not (18 <= crf <= 30):
        raise HTTPException(status_code=400, detail="CRF must be between 18 and 30.")

    item_id = new_id()
    work_dir = paths.compressed_dir() / item_id
    work_dir.mkdir(parents=True, exist_ok=True)

    raw_name = Path(file.filename or "video.mp4").name
    suffix = Path(raw_name).suffix or ".mp4"
    input_path = work_dir / f"input{suffix}"
    out_filename = f"{_safe_stem(raw_name)}_compressed.mp4"
    output_path = work_dir / out_filename

    try:
        with input_path.open("wb") as handle:
            while chunk := await file.read(1024 * 1024):
                handle.write(chunk)
        await file.close()

        settings = load_settings()
        result = await asyncio.to_thread(
            compress_video,
            input_path,
            output_path,
            crf=crf,
            prefer_hardware_encoder=settings.export.prefer_hardware_encoder,
        )
    except CompressError as exc:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise
    finally:
        input_path.unlink(missing_ok=True)

    return CompressOut(
        id=item_id,
        filename=out_filename,
        original_bytes=result.original_bytes,
        compressed_bytes=result.compressed_bytes,
        saved_bytes=result.saved_bytes,
        saved_percent=result.saved_percent,
        download_url=f"/api/compress/{item_id}/download",
    )


@router.get("/{compress_id}/download")
async def download_compressed(compress_id: str) -> FileResponse:
    """Download a previously compressed MP4."""
    if not _ALLOWED_ID_RE.match(compress_id):
        raise HTTPException(status_code=404, detail="Compressed file not found.")

    item_dir = paths.compressed_dir() / compress_id
    if not item_dir.is_dir():
        raise HTTPException(status_code=404, detail="Compressed file not found.")

    mp4s = sorted(item_dir.glob("*_compressed.mp4"))
    if not mp4s:
        raise HTTPException(status_code=404, detail="Compressed file not found.")

    target = mp4s[0]
    return FileResponse(path=target, media_type="video/mp4", filename=target.name)
