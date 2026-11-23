"""Audio-visual active speaker detection with LR-ASD (ONNX Runtime, GPU-first).

Ported from Cutawan's LR-ASD pipeline:
1. Stream 25 fps RGB frames via ffmpeg (using CUDA hwaccel when available),
   detect scene cuts from frame differences, and run strided face detection
   with YuNet (UltraFace RFB-320 fallback) on ONNX Runtime CUDA.
2. Link detections into per-person tracks that never span scene cuts,
   interpolating skipped frames and median-smoothing face boxes.
3. Stream 25 fps grayscale frames to extract 112x112 mouth-centred crops per
   track, and extract 16 kHz mono audio -> 13-dim MFCC features (4 per video
   frame).
4. Score every track with the two-stage LR-ASD ONNX model (frontend + multi-
   window recurrent backend ensemble) on CUDA GPU.
5. Select the active speaker per frame with hysteresis and cooldown so cuts
   read like deliberate camera switches rather than frame-to-frame hunting.
"""

from __future__ import annotations

import logging
import math
import subprocess
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np

from ... import models
from ...cuda import ensure_cuda_libraries
from ...system import report
from .. import ffmpeg
from .faces import FaceObservation
from .mfcc import MFCC_COEFFS, compute_mfcc
from .speaker import SpeakerAssignment
from .tracker import FaceTrack

log = logging.getLogger(__name__)

# --------------------------------------------------------------------------
# Model constants (matching Cutawan / LR-ASD reference preprocessing)
# --------------------------------------------------------------------------

ASD_FPS = 25
DETECT_STRIDE = 5
CROP_SIZE = 112
CROP_SIDE_FACTOR = 0.7
CROP_DOWN_SHIFT = 0.2
CROP_PAD = 110

FRONTEND_BATCH_FRAMES = 25
FRONTEND_CONTEXT_FRAMES = 9
EMBEDDING_SIZE = 128
BACKEND_WINDOWS_SEC = (1, 2, 3, 4, 5, 6)

CROP_PASS_LONG_EDGE = 1920
YUNET_MAX_EDGE = 1280
ULTRAFACE_W = 320
ULTRAFACE_H = 240

ASD_SCENE_CUT_THRESHOLD = 24.0
CUT_MERGE_SEC = 0.3
FACE_PROBE_SEC = 8
FACE_ABSENT_SPARSE_SEC = 3
SCOUT_STRIDE = 12
FULL_DETECT_EVERY = 50
LARGE_FACE_HEIGHT = 0.1
MIN_TRACK_COVERAGE = 0.25

# Face tracking
TRACK_MATCH_IOU = 0.25
TRACK_MAX_GAP_SEC = 0.6
TRACK_MIN_SEC = 0.4
TRACK_MIN_DETECTIONS = 3
TRACK_SMOOTH_SEC = 0.5

# Speaker selection hysteresis — biased toward calm, deliberate podcast cuts
# rather than frantic ping-ponging on laughter or brief interjections.
SPEAK_ON = 0.2
SWITCH_SEC = 0.75
OVERLAP_MARGIN = 1.2
COOLDOWN_SEC = 2.0
UNCONFIRMED_SWITCH_SEC = 0.25

_FRONTEND_FILE = "lr-asd-frontend.onnx"
_BACKEND_FILE = "lr-asd-backend.onnx"
_YUNET_FILE = "face-detection-yunet.onnx"
_ULTRAFACE_FILE = "ultraface-rfb-320.onnx"


@dataclass
class FaceBox:
    """Normalised (0..1) face detection box with optional normalised eye line."""

    x1: float
    y1: float
    x2: float
    y2: float
    score: float
    eye_y: float | None = None

    @property
    def cx(self) -> float:
        return (self.x1 + self.x2) * 0.5

    @property
    def cy(self) -> float:
        return (self.y1 + self.y2) * 0.5

    @property
    def width(self) -> float:
        return self.x2 - self.x1

    @property
    def height(self) -> float:
        return self.y2 - self.y1

    @property
    def area(self) -> float:
        return max(0.0, self.width) * max(0.0, self.height)

    @property
    def resolved_eye_y(self) -> float:
        if self.eye_y is not None and self.y1 <= self.eye_y <= self.y2:
            return self.eye_y
        return self.y1 + 0.35 * self.height


@dataclass
class AsdTrack:
    """One per-person track over contiguous analysis frames at ``ASD_FPS``."""

    start: int
    boxes: list[FaceBox]
    scores: list[float]


@dataclass
class AsdAnalysis:
    tracks: list[AsdTrack]
    frame_count: int
    scene_cuts: list[int]
    fps: int = ASD_FPS
    detector: str = "yunet"


@dataclass
class ScoreSelection:
    """Per-frame active track index (or None) plus frames where speaker switched."""

    track_indices: list[int | None]
    switch_cuts: list[int]


# --------------------------------------------------------------------------
# Model availability & ONNX Runtime GPU sessions
# --------------------------------------------------------------------------


def asd_models_dir() -> Path:
    return models.models_dir() / "asd"


def is_available() -> bool:
    """True when onnxruntime and the required LR-ASD + face detector models exist."""
    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        return False

    root = asd_models_dir()
    has_asd = (root / _FRONTEND_FILE).is_file() and (root / _BACKEND_FILE).is_file()
    has_detector = (root / _YUNET_FILE).is_file() or (root / _ULTRAFACE_FILE).is_file()
    return has_asd and has_detector


def _preferred_ort_providers() -> list[str]:
    ensure_cuda_libraries()
    import onnxruntime as ort

    available = ort.get_available_providers()
    providers: list[str] = []
    if "CUDAExecutionProvider" in available:
        providers.append("CUDAExecutionProvider")
    providers.append("CPUExecutionProvider")
    return providers


@lru_cache(maxsize=8)
def _load_session(model_path: str) -> Any:
    ensure_cuda_libraries()
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    providers = _preferred_ort_providers()
    session = ort.InferenceSession(model_path, sess_options=opts, providers=providers)
    log.info("Loaded ONNX model %s on %s.", Path(model_path).name, session.get_providers()[0])
    return session


def release_sessions() -> None:
    """Release cached ONNX Runtime sessions to reclaim GPU VRAM."""
    _load_session.cache_clear()


# --------------------------------------------------------------------------
# Geometry & NMS helpers
# --------------------------------------------------------------------------


def box_iou(a: FaceBox, b: FaceBox) -> float:
    ix = max(0.0, min(a.x2, b.x2) - max(a.x1, b.x1))
    iy = max(0.0, min(a.y2, b.y2) - max(a.y1, b.y1))
    inter = ix * iy
    if inter <= 0.0:
        return 0.0
    union = a.area + b.area - inter
    return inter / max(1e-9, union)


def _nms(
    boxes: list[FaceBox], iou_threshold: float, *, max_candidates: int = 5000
) -> list[FaceBox]:
    if not boxes:
        return []
    ordered = sorted(boxes, key=lambda b: b.score, reverse=True)[:max_candidates]
    kept: list[FaceBox] = []
    for box in ordered:
        if all(box_iou(box, other) < iou_threshold for other in kept):
            kept.append(box)
    return kept


def face_detection_size(width: int, height: int) -> tuple[int, int]:
    """Preserve aspect ratio with long edge <= 1280 and even dimensions."""
    scale = min(1.0, YUNET_MAX_EDGE / max(1, width, height))
    w = max(2, round(width * scale / 2) * 2)
    h = max(2, round(height * scale / 2) * 2)
    return int(w), int(h)


# --------------------------------------------------------------------------
# Face detectors: YuNet (primary) & UltraFace (fallback)
# --------------------------------------------------------------------------


def _yunet_prepare(rgb: np.ndarray) -> tuple[np.ndarray, int, int]:
    """RGB uint8 (H, W, 3) -> zero-padded unnormalised BGR float32 (1, 3, pH, pW)."""
    h, w, _ = rgb.shape
    padded_w = math.ceil(w / 32) * 32
    padded_h = math.ceil(h / 32) * 32
    tensor = np.zeros((1, 3, padded_h, padded_w), dtype=np.float32)
    tensor[0, 0, :h, :w] = rgb[:, :, 2]  # B
    tensor[0, 1, :h, :w] = rgb[:, :, 1]  # G
    tensor[0, 2, :h, :w] = rgb[:, :, 0]  # R
    return tensor, padded_w, padded_h


def decode_yunet(
    heads: dict[str, np.ndarray],
    padded_width: int,
    width: int,
    height: int,
    *,
    confidence: float = 0.75,
) -> list[FaceBox]:
    """Decode YuNet stride-8/16/32 heads into source-normalised FaceBoxes."""
    candidates: list[FaceBox] = []
    for stride in (8, 16, 32):
        cls = np.asarray(heads[f"cls_{stride}"]).reshape(-1)
        obj = np.asarray(heads[f"obj_{stride}"]).reshape(-1)
        bboxes = np.asarray(heads[f"bbox_{stride}"]).reshape(-1, 4)
        kps_raw = heads.get(f"kps_{stride}")
        kps = np.asarray(kps_raw).reshape(-1, 10) if kps_raw is not None else None

        scores = np.sqrt(np.clip(cls, 0.0, 1.0) * np.clip(obj, 0.0, 1.0))
        keep = np.flatnonzero(np.isfinite(scores) & (scores >= confidence))
        if keep.size == 0:
            continue

        cols = padded_width // stride
        gx = (keep % cols).astype(np.float64)
        gy = (keep // cols).astype(np.float64)
        bb = bboxes[keep].astype(np.float64)

        cx = (gx + bb[:, 0]) * stride
        cy = (gy + bb[:, 1]) * stride
        bw = np.exp(np.clip(bb[:, 2], -20.0, 20.0)) * stride
        bh = np.exp(np.clip(bb[:, 3], -20.0, 20.0)) * stride

        eye_ys: np.ndarray | None = None
        if kps is not None:
            kp = kps[keep].astype(np.float64)
            re_y = (gy + kp[:, 1]) * stride
            le_y = (gy + kp[:, 3]) * stride
            eye_ys = ((re_y + le_y) * 0.5) / height

        for idx in range(keep.size):
            cxi, cyi, bwi, bhi = float(cx[idx]), float(cy[idx]), float(bw[idx]), float(bh[idx])
            if not (
                math.isfinite(cxi)
                and math.isfinite(cyi)
                and math.isfinite(bwi)
                and math.isfinite(bhi)
            ):
                continue
            if cxi < 0.0 or cxi >= width or cyi < 0.0 or cyi >= height:
                continue
            x1 = max(0.0, min(1.0, (cxi - bwi * 0.5) / width))
            y1 = max(0.0, min(1.0, (cyi - bhi * 0.5) / height))
            x2 = max(0.0, min(1.0, (cxi + bwi * 0.5) / width))
            y2 = max(0.0, min(1.0, (cyi + bhi * 0.5) / height))
            if x2 > x1 and y2 > y1:
                ey = (
                    float(eye_ys[idx])
                    if eye_ys is not None and math.isfinite(eye_ys[idx])
                    else None
                )
                candidates.append(
                    FaceBox(x1=x1, y1=y1, x2=x2, y2=y2, score=float(scores[keep[idx]]), eye_y=ey)
                )

    return _nms(candidates, iou_threshold=0.3)


def _detect_yunet(rgb: np.ndarray, session: Any) -> list[FaceBox]:
    h, w, _ = rgb.shape
    tensor, padded_w, _ = _yunet_prepare(rgb)
    output_names = [o.name for o in session.get_outputs()]
    raw_outputs = session.run(output_names, {"input": tensor})
    heads = dict(zip(output_names, raw_outputs, strict=True))
    return decode_yunet(heads, padded_w, w, h)


def _detect_ultraface(rgb: np.ndarray, session: Any, *, confidence: float = 0.65) -> list[FaceBox]:
    # HWC uint8 RGB (240x320) -> CHW float32 (v - 127) / 128
    tensor = ((rgb.astype(np.float32) - 127.0) / 128.0).transpose(2, 0, 1)[None, ...]
    scores_arr, boxes_arr = session.run(["scores", "boxes"], {"input": tensor})
    scores = scores_arr[0, :, 1]
    boxes = boxes_arr[0]
    keep = np.flatnonzero(scores >= confidence)
    candidates = [
        FaceBox(
            x1=float(max(0.0, min(1.0, boxes[i, 0]))),
            y1=float(max(0.0, min(1.0, boxes[i, 1]))),
            x2=float(max(0.0, min(1.0, boxes[i, 2]))),
            y2=float(max(0.0, min(1.0, boxes[i, 3]))),
            score=float(scores[i]),
        )
        for i in keep
        if boxes[i, 2] > boxes[i, 0] and boxes[i, 3] > boxes[i, 1]
    ]
    return _nms(candidates, iou_threshold=0.5)


def _halve_rgb(rgb: np.ndarray) -> np.ndarray:
    h, w, _ = rgb.shape
    hh, hw = h // 2, w // 2
    cropped = rgb[: hh * 2, : hw * 2].astype(np.uint16)
    pooled = (
        cropped[0::2, 0::2] + cropped[0::2, 1::2] + cropped[1::2, 0::2] + cropped[1::2, 1::2] + 2
    ) >> 2
    return pooled.astype(np.uint8)


def _frame_difference(prev: np.ndarray, cur: np.ndarray) -> float:
    """Subsampled mean absolute byte difference matching Cutawan's cut detector."""
    a = prev.reshape(-1)[::24].astype(np.int16)
    b = cur.reshape(-1)[::24].astype(np.int16)
    return float(np.mean(np.abs(a - b))) if a.size else 0.0


def _should_detect_faces(
    frame_index: int, last_face_frame: int, *, scene_cut: bool = False, stride: int = DETECT_STRIDE
) -> bool:
    sparse = (
        frame_index >= FACE_PROBE_SEC * ASD_FPS
        if last_face_frame < 0
        else (frame_index - last_face_frame) >= FACE_ABSENT_SPARSE_SEC * ASD_FPS
    )
    active_stride = SCOUT_STRIDE if sparse else stride
    return scene_cut or (frame_index % active_stride == 0)


# --------------------------------------------------------------------------
# Streaming video frames & audio via ffmpeg (CUDA hwaccel decode when usable)
# --------------------------------------------------------------------------


def _hwaccel_input_args() -> list[str]:
    if report().ffmpeg.cuda_hwaccel_works:
        return ["-hwaccel", "cuda"]
    return []


def _stream_raw_frames(
    video: Path,
    *,
    start_s: float,
    duration_s: float,
    width: int,
    height: int,
    pix_fmt: str,
    bytes_per_pixel: int,
) -> Iterator[bytes]:
    exe = ffmpeg.ffmpeg_path()
    frame_bytes = width * height * bytes_per_pixel

    def _run_stream(use_hwaccel: bool) -> Iterator[bytes]:
        cmd = [
            exe,
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            *(["-hwaccel", "cuda"] if use_hwaccel else []),
            "-ss",
            f"{start_s:.4f}",
            "-t",
            f"{duration_s:.4f}",
            "-i",
            str(video),
            "-vf",
            f"fps={ASD_FPS},scale={width}:{height}",
            "-f",
            "rawvideo",
            "-pix_fmt",
            pix_fmt,
            "pipe:1",
        ]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        assert proc.stdout is not None
        yielded = 0
        try:
            while True:
                buf = bytearray()
                while len(buf) < frame_bytes:
                    chunk = proc.stdout.read(frame_bytes - len(buf))
                    if not chunk:
                        break
                    buf.extend(chunk)
                if len(buf) < frame_bytes:
                    break
                yielded += 1
                yield bytes(buf)
        finally:
            proc.stdout.close()
            stderr_out = proc.stderr.read().decode("utf-8", errors="replace") if proc.stderr else ""
            if proc.stderr:
                proc.stderr.close()
            rc = proc.wait()
            if rc != 0 and yielded == 0:
                raise RuntimeError(f"ffmpeg raw stream failed (rc={rc}): {stderr_out.strip()}")

    use_cuda = bool(_hwaccel_input_args())
    if use_cuda:
        yielded_any = False
        try:
            for frame in _run_stream(True):
                yielded_any = True
                yield frame
            return
        except RuntimeError as exc:
            if yielded_any:
                raise
            log.debug(
                "CUDA hwaccel decode failed for %s (%s); retrying software decode.",
                video.name,
                exc,
            )

    yield from _run_stream(False)


def _extract_mfcc(video: Path, *, start_s: float, duration_s: float) -> np.ndarray | None:
    exe = ffmpeg.ffmpeg_path()
    cmd = [
        exe,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-ss",
        f"{start_s:.4f}",
        "-t",
        f"{duration_s:.4f}",
        "-i",
        str(video),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        "pipe:1",
    ]
    proc = subprocess.run(cmd, capture_output=True, check=False)
    if proc.returncode != 0 or len(proc.stdout) < 3200:
        return None
    usable = (len(proc.stdout) // 2) * 2
    pcm = np.frombuffer(proc.stdout[:usable], dtype=np.int16)
    return compute_mfcc(pcm, 16_000)


# --------------------------------------------------------------------------
# Tracking & smoothing (matching Cutawan facetracks.ts)
# --------------------------------------------------------------------------


def _median_filter(values: list[float], window: int) -> list[float]:
    n = len(values)
    half = window // 2
    out: list[float] = []
    for i in range(n):
        sl = sorted(values[max(0, i - half) : min(n, i + half + 1)])
        out.append(sl[len(sl) // 2])
    return out


def _lerp_box(a: FaceBox, b: FaceBox, t: float) -> FaceBox:
    return FaceBox(
        x1=a.x1 + (b.x1 - a.x1) * t,
        y1=a.y1 + (b.y1 - a.y1) * t,
        x2=a.x2 + (b.x2 - a.x2) * t,
        y2=a.y2 + (b.y2 - a.y2) * t,
        score=a.score + (b.score - a.score) * t,
        eye_y=a.resolved_eye_y + (b.resolved_eye_y - a.resolved_eye_y) * t,
    )


def build_asd_tracks(
    faces_per_frame: list[list[FaceBox] | None],
    scene_cuts: list[int],
    fps: int = ASD_FPS,
) -> list[tuple[int, list[FaceBox]]]:
    """Build per-person interpolated, smoothed tracks that never span scene cuts."""
    cut_set = set(scene_cuts)
    max_gap = max(1, round(TRACK_MAX_GAP_SEC * fps))
    min_len = max(2, round(TRACK_MIN_SEC * fps))
    smooth_window = max(3, round(TRACK_SMOOTH_SEC * fps)) | 1

    done: list[tuple[list[tuple[int, FaceBox]], int]] = []
    # Each active item: {"detections": [(frame, box), ...], "missed_at": int | None}
    active: list[dict[str, Any]] = []

    def finish(track: dict[str, Any], stop: int) -> None:
        dets: list[tuple[int, FaceBox]] = track["detections"]
        last_f = dets[-1][0]
        missed_at = track["missed_at"]
        end_f = max(last_f, min(stop, missed_at if missed_at is not None else stop) - 1)
        if len(dets) >= TRACK_MIN_DETECTIONS and (end_f - dets[0][0] + 1) >= min_len:
            done.append((dets, end_f))

    for f, faces in enumerate(faces_per_frame):
        if f in cut_set:
            for tr in active:
                finish(tr, f)
            active = []

        surviving: list[dict[str, Any]] = []
        for tr in active:
            if f - tr["detections"][-1][0] > max_gap:
                finish(tr, f)
            else:
                surviving.append(tr)
        active = surviving

        if faces is None:
            continue

        used: set[int] = set()
        for box in faces:
            best_idx = -1
            best_iou = TRACK_MATCH_IOU
            for idx, tr in enumerate(active):
                if idx in used:
                    continue
                v = box_iou(tr["detections"][-1][1], box)
                if v > best_iou:
                    best_iou = v
                    best_idx = idx
            if best_idx >= 0:
                used.add(best_idx)
                active[best_idx]["detections"].append((f, box))
                active[best_idx]["missed_at"] = None
            else:
                active.append({"detections": [(f, box)], "missed_at": None})
                used.add(len(active) - 1)

        for idx, tr in enumerate(active):
            if idx not in used and tr["missed_at"] is None:
                tr["missed_at"] = f

    for tr in active:
        finish(tr, len(faces_per_frame))

    tracks: list[tuple[int, list[FaceBox]]] = []
    for dets, end_f in done:
        start_f = dets[0][0]
        raw_boxes: list[FaceBox] = []
        d = 0
        for f in range(start_f, end_f + 1):
            while d < len(dets) - 1 and dets[d + 1][0] <= f:
                d += 1
            cur_f, cur_box = dets[d]
            if cur_f == f or d == len(dets) - 1:
                raw_boxes.append(cur_box)
            else:
                next_f, next_box = dets[d + 1]
                t = (f - cur_f) / (next_f - cur_f)
                raw_boxes.append(_lerp_box(cur_box, next_box, t))

        cxs = _median_filter([b.cx for b in raw_boxes], smooth_window)
        cys = _median_filter([b.cy for b in raw_boxes], smooth_window)
        ws = _median_filter([b.width for b in raw_boxes], smooth_window)
        hs = _median_filter([b.height for b in raw_boxes], smooth_window)
        eyes = _median_filter([b.resolved_eye_y for b in raw_boxes], smooth_window)
        smoothed = [
            FaceBox(
                x1=cxs[i] - ws[i] * 0.5,
                y1=cys[i] - hs[i] * 0.5,
                x2=cxs[i] + ws[i] * 0.5,
                y2=cys[i] + hs[i] * 0.5,
                score=raw_boxes[i].score,
                eye_y=eyes[i],
            )
            for i in range(len(raw_boxes))
        ]
        tracks.append((start_f, smoothed))

    return tracks


def _track_coverage_ratio(tracks: list[tuple[int, list[FaceBox]]], frame_count: int) -> float:
    covered = 0
    end = 0
    for start, boxes in sorted(tracks, key=lambda item: item[0]):
        stop = min(frame_count, start + len(boxes))
        covered += max(0, stop - max(end, start))
        end = max(end, stop)
    return covered / max(1, frame_count)


# --------------------------------------------------------------------------
# Mouth cropping & LR-ASD scoring (GPU ONNX)
# --------------------------------------------------------------------------


def _crop_mouth_patch(gray: np.ndarray, cx: float, cy: float, side: float) -> np.ndarray:
    """Bilinearly sample a square mouth-centred region to 112x112 uint8."""
    import cv2

    scale = CROP_SIZE / max(1e-6, side)
    # Match Cutawan's pixel-centre mapping: sy = (cy - side/2) + (oy + 0.5)*step - 0.5
    tx = (CROP_SIZE * 0.5) - cx * scale
    ty = (CROP_SIZE * 0.5) - cy * scale
    matrix = np.array([[scale, 0.0, tx], [0.0, scale, ty]], dtype=np.float32)
    return cv2.warpAffine(
        gray,
        matrix,
        (CROP_SIZE, CROP_SIZE),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=CROP_PAD,
    )


def _mfcc_slice(mfcc: np.ndarray, start_frame: int, num_frames: int) -> np.ndarray:
    """Return ``(num_frames * 4, 13)`` float32 MFCC rows, padding tail if short."""
    total = mfcc.shape[0]
    need = num_frames * 4
    if total == 0:
        return np.zeros((need, MFCC_COEFFS), dtype=np.float32)
    indices = np.minimum(total - 1, start_frame * 4 + np.arange(need))
    return np.ascontiguousarray(mfcc[indices], dtype=np.float32)


def _smooth_scores(scores: np.ndarray) -> list[float]:
    """Mean smoothing over ±2 frames."""
    n = scores.size
    out = np.empty(n, dtype=np.float32)
    for i in range(n):
        out[i] = float(np.mean(scores[max(0, i - 2) : min(n, i + 3)]))
    return [float(x) for x in out]


def _score_track(
    crops: np.ndarray,
    mfcc: np.ndarray | None,
    track_start: int,
    frontend_session: Any,
    backend_session: Any,
) -> list[float]:
    """Run LR-ASD frontend + multi-window backend ensemble over one track."""
    frames = crops.shape[0]
    if frames < 2:
        return []

    audio = (
        _mfcc_slice(mfcc, track_start, frames)
        if mfcc is not None
        else np.zeros((frames * 4, MFCC_COEFFS), dtype=np.float32)
    )

    embed_a = np.empty((frames, EMBEDDING_SIZE), dtype=np.float32)
    embed_v = np.empty((frames, EMBEDDING_SIZE), dtype=np.float32)

    for start in range(0, frames, FRONTEND_BATCH_FRAMES):
        end = min(frames, start + FRONTEND_BATCH_FRAMES)
        in_from = max(0, start - FRONTEND_CONTEXT_FRAMES)
        in_to = min(frames, end + FRONTEND_CONTEXT_FRAMES)

        video_batch = crops[in_from:in_to].astype(np.float32)[None, ...]
        audio_batch = audio[in_from * 4 : in_to * 4][None, ...]
        out_a, out_v = frontend_session.run(
            ["embedA", "embedV"], {"audio": audio_batch, "video": video_batch}
        )
        offset = start - in_from
        length = end - start
        embed_a[start:end] = out_a[0, offset : offset + length]
        embed_v[start:end] = out_v[0, offset : offset + length]

    if mfcc is None:
        scores = np.empty(frames, dtype=np.float32)
        for start in range(0, frames, 150):
            end = min(frames, start + 150)
            _, scores_v = backend_session.run(
                ["scoresAV", "scoresV"],
                {"embedA": embed_a[start:end][None, ...], "embedV": embed_v[start:end][None, ...]},
            )
            scores[start:end] = np.asarray(scores_v).reshape(-1)
        return _smooth_scores(scores)

    total_scores = np.zeros(frames, dtype=np.float32)
    passes = 0
    for seconds in BACKEND_WINDOWS_SEC:
        window = seconds * ASD_FPS
        for start in range(0, frames, window):
            end = min(frames, start + window)
            scores_av, _ = backend_session.run(
                ["scoresAV", "scoresV"],
                {"embedA": embed_a[start:end][None, ...], "embedV": embed_v[start:end][None, ...]},
            )
            total_scores[start:end] += np.asarray(scores_av).reshape(-1)
        passes += 1
        if window >= frames:
            break

    return _smooth_scores(total_scores / max(1, passes))


# --------------------------------------------------------------------------
# Speaker selection from ASD scores (matching Cutawan speaker.ts)
# --------------------------------------------------------------------------


def choose_speaker_by_scores(
    tracks: list[AsdTrack],
    frame_count: int,
    scene_cuts: list[int],
    fps: int = ASD_FPS,
) -> ScoreSelection:
    """Choose the active track index per frame using LR-ASD logits + hysteresis."""
    switch_frames = max(1, round(SWITCH_SEC * fps))
    fast_frames = max(1, round(UNCONFIRMED_SWITCH_SEC * fps))
    cooldown_frames = max(1, round(COOLDOWN_SEC * fps))
    cut_set = set(scene_cuts)

    per_frame: list[list[int]] = [[] for _ in range(frame_count)]
    for idx, track in enumerate(tracks):
        stop = min(frame_count, track.start + len(track.scores))
        for f in range(max(0, track.start), stop):
            per_frame[f].append(idx)

    def at(track_idx: int, frame_idx: int) -> tuple[float, float, float]:
        tr = tracks[track_idx]
        k = frame_idx - tr.start
        box = tr.boxes[k]
        return box.cx, box.area, tr.scores[k]

    chosen: list[int | None] = []
    switch_cuts: list[int] = []
    current = -1
    confirmed = False
    challenger = -1
    challenger_streak = 0
    cooldown = 0
    last_centre: float | None = None

    for f in range(frame_count):
        if f in cut_set:
            current = -1
            confirmed = False
            challenger = -1
            challenger_streak = 0
            cooldown = 0
            last_centre = None

        candidates = per_frame[f]
        if not candidates:
            chosen.append(None)
            continue

        if cooldown > 0:
            cooldown -= 1

        if current == -1 or current not in candidates:
            speaking = [i for i in candidates if at(i, f)[2] > SPEAK_ON]
            if speaking:
                current = max(speaking, key=lambda i: at(i, f)[2])
                confirmed = True
            elif last_centre is not None:
                anchor = last_centre
                current = min(candidates, key=lambda i: abs(at(i, f)[0] - anchor))
            else:
                current = max(candidates, key=lambda i: at(i, f)[1])
                confirmed = False
            challenger = -1
            challenger_streak = 0
        else:
            cur_cx, _, cur_score = at(current, f)
            if cur_score > SPEAK_ON:
                confirmed = True

            bar = cur_score + OVERLAP_MARGIN if cur_score > SPEAK_ON else SPEAK_ON
            rival = -1
            rival_score = bar
            for i in candidates:
                if i == current:
                    continue
                s = at(i, f)[2]
                if s > rival_score:
                    rival = i
                    rival_score = s

            gated = confirmed and cooldown > 0
            if rival != -1 and not gated:
                if challenger == rival:
                    challenger_streak += 1
                else:
                    challenger = rival
                    challenger_streak = 1
                needed = switch_frames if confirmed else fast_frames
                if challenger_streak >= needed:
                    current = rival
                    confirmed = True
                    switch_cuts.append(f)
                    challenger = -1
                    challenger_streak = 0
                    cooldown = cooldown_frames
            else:
                challenger = -1
                challenger_streak = 0

        last_centre = at(current, f)[0]
        chosen.append(current)

    return ScoreSelection(track_indices=chosen, switch_cuts=switch_cuts)


# --------------------------------------------------------------------------
# Top-level clip analysis & conversion to AutoClip tracks/assignments
# --------------------------------------------------------------------------


def analyze_clip_asd(
    video: Path,
    *,
    start_s: float,
    end_s: float,
    source_w: int,
    source_h: int,
    has_audio: bool = True,
) -> AsdAnalysis | None:
    """Run full GPU-accelerated LR-ASD analysis on one clip."""
    if not is_available():
        return None

    duration_s = max(0.1, end_s - start_s)
    root = asd_models_dir()
    yunet_path = root / _YUNET_FILE
    ultraface_path = root / _ULTRAFACE_FILE

    use_yunet = yunet_path.is_file()
    if use_yunet:
        det_w, det_h = face_detection_size(source_w, source_h)
        det_session = _load_session(str(yunet_path))
        detector_name = "yunet"
    else:
        det_w, det_h = ULTRAFACE_W, ULTRAFACE_H
        det_session = _load_session(str(ultraface_path))
        detector_name = "ultraface"

    # Pass 1: detection + scene cuts at 25 fps (face detection strided at 5 fps).
    faces_per_frame: list[list[FaceBox] | None] = []
    raw_cuts: list[int] = []
    prev_frame: np.ndarray | None = None
    last_face_frame = -1
    last_full = -10_000
    full_count = 0
    all_large = False

    def detect_frame(rgb: np.ndarray, frame_idx: int, is_cut: bool) -> list[FaceBox]:
        nonlocal last_full, full_count, all_large
        if not use_yunet:
            return _detect_ultraface(rgb, det_session)

        half_ok = not is_cut and all_large and (frame_idx - last_full) < FULL_DETECT_EVERY
        if half_ok:
            faces = _detect_yunet(_halve_rgb(rgb), det_session)
            if len(faces) >= full_count:
                return faces

        faces = _detect_yunet(rgb, det_session)
        if not faces:
            faces = _detect_yunet(_halve_rgb(rgb), det_session)

        last_full = frame_idx
        full_count = len(faces)
        all_large = bool(faces) and all(face.height >= LARGE_FACE_HEIGHT for face in faces)
        return faces

    for f, raw in enumerate(
        _stream_raw_frames(
            video,
            start_s=start_s,
            duration_s=duration_s,
            width=det_w,
            height=det_h,
            pix_fmt="rgb24",
            bytes_per_pixel=3,
        )
    ):
        rgb = np.frombuffer(raw, dtype=np.uint8).reshape((det_h, det_w, 3))
        diff = _frame_difference(prev_frame, rgb) if prev_frame is not None else 0.0
        is_cut = diff > ASD_SCENE_CUT_THRESHOLD
        if is_cut:
            raw_cuts.append(f)

        if _should_detect_faces(f, last_face_frame, scene_cut=is_cut):
            faces = detect_frame(rgb, f, is_cut)
            faces_per_frame.append(faces)
            if faces:
                last_face_frame = f
        else:
            faces_per_frame.append(None)

        prev_frame = rgb

    frame_count = len(faces_per_frame)
    if frame_count == 0:
        return None

    merge_window = max(1, round(CUT_MERGE_SEC * ASD_FPS))
    scene_cuts = [
        cut
        for i, cut in enumerate(raw_cuts)
        if i == len(raw_cuts) - 1 or (raw_cuts[i + 1] - cut) > merge_window
    ]

    raw_tracks = build_asd_tracks(faces_per_frame, scene_cuts, ASD_FPS)
    if not raw_tracks or _track_coverage_ratio(raw_tracks, frame_count) < MIN_TRACK_COVERAGE:
        return AsdAnalysis(
            tracks=[],
            frame_count=frame_count,
            scene_cuts=scene_cuts,
            fps=ASD_FPS,
            detector=detector_name,
        )

    # Pass 2: grayscale crop stream + audio MFCC extraction in parallel.
    long_edge = max(source_w, source_h, 1)
    crop_w = max(2, 2 * int(min(source_w, CROP_PASS_LONG_EDGE * source_w / long_edge) // 2))
    crop_h = max(2, 2 * round((crop_w * source_h) / max(1, source_w) / 2))

    track_crops = [
        np.empty((len(boxes), CROP_SIZE, CROP_SIZE), dtype=np.uint8) for _, boxes in raw_tracks
    ]

    def run_crop_pass() -> None:
        for f, raw in enumerate(
            _stream_raw_frames(
                video,
                start_s=start_s,
                duration_s=duration_s,
                width=crop_w,
                height=crop_h,
                pix_fmt="gray",
                bytes_per_pixel=1,
            )
        ):
            gray = np.frombuffer(raw, dtype=np.uint8).reshape((crop_h, crop_w))
            for t_idx, (t_start, boxes) in enumerate(raw_tracks):
                rel = f - t_start
                if 0 <= rel < len(boxes):
                    box = boxes[rel]
                    bw = box.width * crop_w
                    bh = box.height * crop_h
                    size = max(bw, bh)
                    cx = box.cx * crop_w
                    cy = box.cy * crop_h + CROP_DOWN_SHIFT * size
                    side = max(4.0, size * CROP_SIDE_FACTOR)
                    track_crops[t_idx][rel] = _crop_mouth_patch(gray, cx, cy, side)

    with ThreadPoolExecutor(max_workers=2) as pool:
        crop_future = pool.submit(run_crop_pass)
        mfcc_future = (
            pool.submit(_extract_mfcc, video, start_s=start_s, duration_s=duration_s)
            if has_audio
            else None
        )
        crop_future.result()
        mfcc = mfcc_future.result() if mfcc_future is not None else None

    # Pass 3: score every face track with LR-ASD on CUDA GPU.
    frontend = _load_session(str(root / _FRONTEND_FILE))
    backend = _load_session(str(root / _BACKEND_FILE))

    scored_tracks: list[AsdTrack] = []
    for t_idx, (t_start, boxes) in enumerate(raw_tracks):
        scores = _score_track(track_crops[t_idx], mfcc, t_start, frontend, backend)
        if len(scores) < 2:
            continue
        scored_tracks.append(AsdTrack(start=t_start, boxes=boxes[: len(scores)], scores=scores))

    log.info(
        "LR-ASD analysed %d frames (%d cut(s), %d scored track(s), detector=%s).",
        frame_count,
        len(scene_cuts),
        len(scored_tracks),
        detector_name,
    )
    return AsdAnalysis(
        tracks=scored_tracks,
        frame_count=frame_count,
        scene_cuts=scene_cuts,
        fps=ASD_FPS,
        detector=detector_name,
    )


def to_face_tracks(analysis: AsdAnalysis, source_w: int, source_h: int) -> list[FaceTrack]:
    """Convert normalised ASD tracks into AutoClip pixel-space ``FaceTrack``s."""
    face_tracks: list[FaceTrack] = []
    for idx, tr in enumerate(analysis.tracks):
        observations: list[FaceObservation] = []
        for k, box in enumerate(tr.boxes):
            t = (tr.start + k) / analysis.fps
            observations.append(
                FaceObservation(
                    t=t,
                    cx=box.cx * source_w,
                    cy=box.cy * source_h,
                    width=box.width * source_w,
                    height=box.height * source_h,
                    eye_y=box.resolved_eye_y * source_h,
                    mar=0.0,
                )
            )
        face_tracks.append(FaceTrack(id=idx, observations=observations))
    return face_tracks


def assignments_from_asd(
    analysis: AsdAnalysis,
    face_tracks: list[FaceTrack],
    duration_s: float,
) -> list[SpeakerAssignment]:
    """Convert LR-ASD per-frame speaker choices into contiguous ``SpeakerAssignment``s."""
    if analysis.frame_count == 0 or not analysis.tracks:
        return [SpeakerAssignment(0.0, duration_s, None)]

    selection = choose_speaker_by_scores(
        analysis.tracks, analysis.frame_count, analysis.scene_cuts, analysis.fps
    )
    cut_set = set(analysis.scene_cuts) | set(selection.switch_cuts)

    assignments: list[SpeakerAssignment] = []
    run_start = 0
    run_track = selection.track_indices[0]

    for f in range(1, analysis.frame_count):
        cur = selection.track_indices[f]
        if f in cut_set or cur != run_track:
            start_t = run_start / analysis.fps
            end_t = f / analysis.fps
            track_obj = face_tracks[run_track] if run_track is not None else None
            assignments.append(SpeakerAssignment(start_t, end_t, track_obj))
            run_start = f
            run_track = cur

    start_t = run_start / analysis.fps
    track_obj = face_tracks[run_track] if run_track is not None else None
    assignments.append(SpeakerAssignment(start_t, duration_s, track_obj))

    return [a for a in assignments if a.end_s > a.start_s]
