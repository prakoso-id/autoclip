"""Unit tests for the LR-ASD audio-visual active speaker detection port."""

from __future__ import annotations

import math

import numpy as np
import pytest
from autoclip.pipeline.reframe import asd
from autoclip.pipeline.reframe.asd import (
    AsdAnalysis,
    AsdTrack,
    FaceBox,
    assignments_from_asd,
    build_asd_tracks,
    choose_speaker_by_scores,
    decode_yunet,
    face_detection_size,
    to_face_tracks,
)
from autoclip.pipeline.reframe.mfcc import MFCC_COEFFS, compute_mfcc


class TestMfcc:
    def test_empty_input_returns_empty_matrix(self) -> None:
        out = compute_mfcc(np.array([], dtype=np.int16), 16_000)

        assert out.shape == (0, MFCC_COEFFS)
        assert out.dtype == np.float32

    def test_one_second_gives_expected_frame_count_and_finite_values(self) -> None:
        t = np.arange(16_000, dtype=np.float64) / 16_000.0
        pcm = (10_000.0 * np.sin(2.0 * math.pi * 440.0 * t)).astype(np.int16)

        feats = compute_mfcc(pcm, 16_000)

        assert feats.shape == (99, MFCC_COEFFS)
        assert np.all(np.isfinite(feats))
        # Silent signal should have much lower log energy (c0) than tone.
        silent = compute_mfcc(np.zeros(16_000, dtype=np.int16), 16_000)
        assert float(np.mean(feats[:, 0])) > float(np.mean(silent[:, 0])) + 5.0


class TestYuNetDecode:
    def test_face_detection_size_caps_at_1280_and_stays_even(self) -> None:
        assert face_detection_size(1920, 1080) == (1280, 720)
        assert face_detection_size(640, 360) == (640, 360)

    def test_decodes_single_face_with_eye_keypoints(self) -> None:
        # 64x64 image -> stride 8 has 8x8=64 anchors, stride 16 has 16, stride 32 has 4.
        heads: dict[str, np.ndarray] = {}
        for stride, count in ((8, 64), (16, 16), (32, 4)):
            heads[f"cls_{stride}"] = np.zeros((1, count, 1), dtype=np.float32)
            heads[f"obj_{stride}"] = np.zeros((1, count, 1), dtype=np.float32)
            heads[f"bbox_{stride}"] = np.zeros((1, count, 4), dtype=np.float32)
            heads[f"kps_{stride}"] = np.zeros((1, count, 10), dtype=np.float32)

        # Put a strong detection at stride 16, anchor index 5 -> (gx=1, gy=1).
        heads["cls_16"][0, 5, 0] = 0.95
        heads["obj_16"][0, 5, 0] = 0.95
        heads["bbox_16"][0, 5] = [0.5, 0.5, math.log(1.5), math.log(1.5)]
        # Eyes slightly above centre (gy + 0.25) * 16 = 20px -> 20/64 = 0.3125
        heads["kps_16"][0, 5] = [0.3, 0.25, 0.7, 0.25, 0.5, 0.5, 0.35, 0.75, 0.65, 0.75]

        boxes = decode_yunet(heads, padded_width=64, width=64, height=64, confidence=0.75)

        assert len(boxes) == 1
        box = boxes[0]
        assert box.cx == pytest.approx(24.0 / 64.0, abs=1e-3)
        assert box.cy == pytest.approx(24.0 / 64.0, abs=1e-3)
        assert box.resolved_eye_y == pytest.approx(20.0 / 64.0, abs=1e-3)


class TestAsdTracks:
    def _box(self, cx: float, cy: float = 0.4) -> FaceBox:
        return FaceBox(x1=cx - 0.08, y1=cy - 0.12, x2=cx + 0.08, y2=cy + 0.12, score=0.95)

    def test_tracks_interpolate_skipped_frames_and_break_at_scene_cuts(self) -> None:
        # 50 frames (2s at 25fps), strided detections every 5 frames, cut at frame 25.
        faces_per_frame: list[list[FaceBox] | None] = []
        for f in range(50):
            if f % 5 == 0:
                faces_per_frame.append([self._box(0.3 if f < 25 else 0.7)])
            else:
                faces_per_frame.append(None)

        tracks = build_asd_tracks(faces_per_frame, scene_cuts=[25], fps=25)

        assert len(tracks) == 2
        assert tracks[0][0] == 0
        assert tracks[0][0] + len(tracks[0][1]) <= 25
        assert tracks[1][0] == 25


class TestSpeakerSelection:
    def _track(self, start: int, cx: float, scores: list[float]) -> AsdTrack:
        boxes = [FaceBox(x1=cx - 0.08, y1=0.25, x2=cx + 0.08, y2=0.55, score=0.95) for _ in scores]
        return AsdTrack(start=start, boxes=boxes, scores=scores)

    def test_switches_only_when_rival_sustains_speaking(self) -> None:
        # 100 frames (4s at 25fps): track 0 speaks 0..50, track 1 speaks 50..100.
        t0 = self._track(0, 0.25, [2.0] * 50 + [-2.0] * 50)
        t1 = self._track(0, 0.75, [-2.0] * 50 + [2.0] * 50)

        sel = choose_speaker_by_scores([t0, t1], frame_count=100, scene_cuts=[], fps=25)

        assert sel.track_indices[0] == 0
        assert sel.track_indices[49] == 0
        assert len(sel.switch_cuts) == 1
        assert sel.switch_cuts[0] >= 50
        assert sel.track_indices[-1] == 1

    def test_ignores_brief_overlap_spike(self) -> None:
        # Track 0 speaks throughout; track 1 has only a 3-frame spike (< 0.4s switch window).
        t0 = self._track(0, 0.25, [1.5] * 60)
        scores1 = [-2.0] * 25 + [3.5] * 3 + [-2.0] * 32
        t1 = self._track(0, 0.75, scores1)

        sel = choose_speaker_by_scores([t0, t1], frame_count=60, scene_cuts=[], fps=25)

        assert sel.switch_cuts == []
        assert all(idx == 0 for idx in sel.track_indices)

    def test_assignments_from_asd_cover_full_duration(self) -> None:
        t0 = self._track(0, 0.25, [2.0] * 50 + [-2.0] * 50)
        t1 = self._track(0, 0.75, [-2.0] * 50 + [2.0] * 50)
        analysis = AsdAnalysis(tracks=[t0, t1], frame_count=100, scene_cuts=[], fps=25)

        face_tracks = to_face_tracks(analysis, 1920, 1080)
        assignments = assignments_from_asd(analysis, face_tracks, duration_s=4.0)

        assert len(assignments) == 2
        assert assignments[0].start_s == 0.0
        assert assignments[-1].end_s == 4.0
        assert assignments[0].track is face_tracks[0]
        assert assignments[1].track is face_tracks[1]

    def test_asd_availability_helper_returns_bool(self) -> None:
        assert isinstance(asd.is_available(), bool)
