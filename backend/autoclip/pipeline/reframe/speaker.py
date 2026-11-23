"""Active speaker selection.

Two signals, combined:

**Mouth movement.** The variance of a track's mouth-aspect ratio over a window
rises while that person talks. On its own it confuses talking with chewing,
laughing, or nodding emphatically.

**Diarization.** Tells us *when* each speaker holds the floor, but not *which
face* they are. Correlating each track's mouth activity against each diarized
speaker's timeline resolves that once for the whole clip, after which turn
boundaries alone drive the framing — which is far more stable than deciding
frame by frame.

A full audio-visual model (TalkNet, LR-ASD) would beat this. It's on the v2 list;
this heuristic is what runs on a laptop without another 400 MB of weights.
"""

from __future__ import annotations

import logging
import statistics
from dataclasses import dataclass

from .tracker import FaceTrack

log = logging.getLogger(__name__)

#: Window over which mouth activity is measured when correlating with turns.
ACTIVITY_WINDOW_S = 1.0

#: Mouth-activity variance below this is treated as a closed, still mouth.
SILENT_MAR_VARIANCE = 0.0004

#: A track must beat the runner-up by this factor to be called the speaker on
#: mouth movement alone. Without the margin, near-ties flip frame to frame and
#: the framing oscillates between two faces.
DOMINANCE_MARGIN = 1.6


@dataclass
class SpeakerAssignment:
    """Which track holds the frame over a time range."""

    start_s: float
    end_s: float
    track: FaceTrack | None
    #: True when several faces are present and none is clearly speaking.
    ambiguous: bool = False


#: Minimum temporal overlap (seconds) to consider two tracks as simultaneous people.
_SIMULTANEOUS_OVERLAP_S = 0.4


def _tracks_overlap(a: FaceTrack, b: FaceTrack) -> bool:
    """True when two tracks coexist long enough to be distinct people in frame."""
    overlap = min(a.end_s, b.end_s) - max(a.start_s, b.start_s)
    return overlap >= _SIMULTANEOUS_OVERLAP_S


def map_tracks_to_speakers_multi(
    tracks: list[FaceTrack],
    turns: list[tuple[str, float, float]],
) -> dict[str, list[FaceTrack]]:
    """Associate each diarized speaker with one or more non-overlapping face tracks.

    A single speaker commonly produces multiple ``FaceTrack`` IDs over a clip
    whenever a camera cut or brief face-detection dropout exceeds ``MAX_GAP_S``.
    Allowing non-overlapping tracks to share a speaker label keeps turn-driven
    framing working across cuts while preventing two simultaneously visible
    people from being mapped to the same speaker.

    Preconditions:
        turns are clip-relative ``(speaker, start, end)`` tuples.
    """
    if not tracks or not turns:
        return {}

    scores: dict[str, dict[int, float]] = {}
    for speaker, start, end in turns:
        if end - start < 0.4:
            continue
        per_track = scores.setdefault(speaker, {})
        for track in tracks:
            activity = track.mouth_activity(start, end)
            if activity > 0:
                per_track[track.id] = per_track.get(track.id, 0.0) + activity * (end - start)

    by_id = {track.id: track for track in tracks}
    mapping: dict[str, list[FaceTrack]] = {}
    claimed_tracks: set[int] = set()

    # Assign strongest speaker-track pairings first. A track can only belong to
    # one speaker, while a speaker can own multiple non-overlapping tracks
    # (e.g. before and after a shot cut or dropout).
    ranked = sorted(
        (
            (total, speaker, track_id)
            for speaker, per_track in scores.items()
            for track_id, total in per_track.items()
        ),
        reverse=True,
    )
    for _, speaker, track_id in ranked:
        if track_id in claimed_tracks:
            continue
        candidate = by_id[track_id]
        existing = mapping.get(speaker, [])
        if any(_tracks_overlap(candidate, other) for other in existing):
            continue
        mapping.setdefault(speaker, []).append(candidate)
        claimed_tracks.add(track_id)

    if mapping:
        total_tracks = sum(len(v) for v in mapping.values())
        log.debug("Mapped %d speaker(s) across %d face track(s).", len(mapping), total_tracks)
    return mapping


def map_tracks_to_speakers(
    tracks: list[FaceTrack],
    turns: list[tuple[str, float, float]],
) -> dict[str, FaceTrack]:
    """Associate each diarized speaker label with their strongest face track.

    Kept for callers expecting a single primary track per speaker; see
    :func:`map_tracks_to_speakers_multi` for multi-shot tracking.
    """
    multi = map_tracks_to_speakers_multi(tracks, turns)
    return {speaker: group[0] for speaker, group in multi.items() if group}


def assign_speakers(
    tracks: list[FaceTrack],
    *,
    shot_start_s: float,
    shot_end_s: float,
    turns: list[tuple[str, float, float]] | None = None,
    speaker_map: dict[str, FaceTrack] | dict[str, list[FaceTrack]] | None = None,
) -> list[SpeakerAssignment]:
    """Decide which track holds the frame across a shot.

    Returns one assignment per stable span. A single-face shot resolves to one
    assignment covering the whole shot; a two-person shot with diarization
    resolves to one per turn.
    """
    visible = [t for t in tracks if t.observations_between(shot_start_s, shot_end_s)]

    if not visible:
        return [SpeakerAssignment(shot_start_s, shot_end_s, None)]

    if len(visible) == 1:
        return [SpeakerAssignment(shot_start_s, shot_end_s, visible[0])]

    if turns and speaker_map:
        assignments = _assignments_from_turns(visible, shot_start_s, shot_end_s, turns, speaker_map)
        if assignments:
            return assignments

    # If the clip-level mapping missed this shot's tracks (e.g. new IDs after a
    # cut), correlate turns locally against just the faces visible in this shot.
    if turns:
        shot_turns = [
            (spk, max(s, shot_start_s), min(e, shot_end_s))
            for spk, s, e in turns
            if min(e, shot_end_s) > max(s, shot_start_s)
        ]
        if shot_turns:
            local_map = map_tracks_to_speakers_multi(visible, shot_turns)
            if local_map:
                assignments = _assignments_from_turns(
                    visible, shot_start_s, shot_end_s, shot_turns, local_map
                )
                if assignments:
                    return assignments

    return [_assignment_from_mouth_activity(visible, shot_start_s, shot_end_s)]


def _pick_track_for_turn(
    mapped: FaceTrack | list[FaceTrack] | None,
    visible_ids: set[int],
    start_s: float,
    end_s: float,
) -> FaceTrack | None:
    if mapped is None:
        return None
    candidates = mapped if isinstance(mapped, list) else [mapped]
    eligible = [t for t in candidates if t.id in visible_ids]
    if not eligible:
        return None
    if len(eligible) == 1:
        return eligible[0]
    return max(eligible, key=lambda t: len(t.observations_between(start_s, end_s)))


def _assignments_from_turns(
    visible: list[FaceTrack],
    shot_start_s: float,
    shot_end_s: float,
    turns: list[tuple[str, float, float]],
    speaker_map: dict[str, FaceTrack] | dict[str, list[FaceTrack]],
) -> list[SpeakerAssignment]:
    """Build assignments from diarization turns overlapping the shot."""
    visible_ids = {t.id for t in visible}
    assignments: list[SpeakerAssignment] = []

    for speaker, start, end in turns:
        overlap_start = max(start, shot_start_s)
        overlap_end = min(end, shot_end_s)
        if overlap_end <= overlap_start:
            continue

        track = _pick_track_for_turn(
            speaker_map.get(speaker), visible_ids, overlap_start, overlap_end
        )
        if track is None:
            continue

        # Extend rather than append when the same face keeps the floor, so a
        # rapid A-A-B turn sequence produces one hold, not two identical cuts.
        if assignments and assignments[-1].track is track:
            assignments[-1] = SpeakerAssignment(assignments[-1].start_s, overlap_end, track)
        else:
            assignments.append(SpeakerAssignment(overlap_start, overlap_end, track))

    if not assignments:
        return []

    # Close gaps so the shot is fully covered; a hole would leave the crop
    # undefined for those frames.
    assignments[0] = SpeakerAssignment(shot_start_s, assignments[0].end_s, assignments[0].track)
    assignments[-1] = SpeakerAssignment(assignments[-1].start_s, shot_end_s, assignments[-1].track)
    for index in range(len(assignments) - 1):
        assignments[index] = SpeakerAssignment(
            assignments[index].start_s,
            assignments[index + 1].start_s,
            assignments[index].track,
        )

    return [a for a in assignments if a.end_s > a.start_s]


def _assignment_from_mouth_activity(
    visible: list[FaceTrack], shot_start_s: float, shot_end_s: float
) -> SpeakerAssignment:
    """Pick a speaker from mouth movement alone, or declare the shot ambiguous."""
    activity = [(track, track.mouth_activity(shot_start_s, shot_end_s)) for track in visible]
    activity.sort(key=lambda pair: pair[1], reverse=True)

    best_track, best_score = activity[0]
    runner_up = activity[1][1] if len(activity) > 1 else 0.0

    if best_score < SILENT_MAR_VARIANCE:
        # Nobody is visibly talking — an interview cutaway, or a shot of an
        # audience. Hold everyone rather than guessing.
        return SpeakerAssignment(shot_start_s, shot_end_s, None, ambiguous=True)

    if runner_up > 0 and best_score < runner_up * DOMINANCE_MARGIN:
        return SpeakerAssignment(shot_start_s, shot_end_s, None, ambiguous=True)

    return SpeakerAssignment(shot_start_s, shot_end_s, best_track)


def prominence(track: FaceTrack, frame_width: float, shot_duration_s: float) -> float:
    """Fallback ranking when no speech signal resolves the choice.

    Largest, most central, most persistent — in that order of weight. This is
    the "single face in shot" case, where any reasonable metric agrees.
    """
    if shot_duration_s <= 0:
        return 0.0
    size = track.mean_area**0.5
    persistence = min(1.0, track.duration_s / shot_duration_s)
    return size * (0.5 + 0.5 * track.centrality(frame_width)) * (0.4 + 0.6 * persistence)


def mean_mar(track: FaceTrack, start_s: float, end_s: float) -> float:
    values = [o.mar for o in track.observations_between(start_s, end_s)]
    return statistics.fmean(values) if values else 0.0
