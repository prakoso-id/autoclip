"""Crop-path smoothing.

Raw per-frame face positions are far too noisy to drive a crop directly —
detection jitter of a few pixels reads as a shaking camera. The chain here is
deliberately three stages:

1. **One Euro Filter** — adaptive low-pass. At low speed it filters hard (kills
   jitter); at high speed it filters lightly (keeps up with a real pan). A plain
   EMA has to choose one or the other, so it either shakes or lags.
2. **Dead zone** — below a movement threshold, don't move at all. A locked frame
   reads as intentional; a frame that micro-corrects reads as broken.
3. **Velocity clamp** — cap how fast the crop can travel, so a detection glitch
   can never whip the frame across the shot.

Reference: Casiez, Roussel & Vogel, "1€ Filter" (CHI 2012).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

#: Lower cutoff filters harder at rest. Tuned for face tracking at 5-10 Hz
#: sampling, where detection noise dominates below ~1 Hz.
DEFAULT_MIN_CUTOFF = 0.6
#: How aggressively the cutoff opens up with speed. Higher means less lag on
#: fast movement, at the cost of letting more jitter through.
DEFAULT_BETA = 0.02
DEFAULT_DERIVATIVE_CUTOFF = 1.0


def _alpha(cutoff: float, dt: float) -> float:
    tau = 1.0 / (2.0 * math.pi * cutoff)
    return 1.0 / (1.0 + tau / dt)


class LowPass:
    """First-order low-pass filter with a settable per-sample alpha."""

    def __init__(self) -> None:
        self.value: float | None = None

    def __call__(self, sample: float, alpha: float) -> float:
        if self.value is None:
            self.value = sample
        else:
            self.value = alpha * sample + (1.0 - alpha) * self.value
        return self.value


class OneEuroFilter:
    """Adaptive low-pass filter trading jitter against lag by signal speed."""

    def __init__(
        self,
        *,
        min_cutoff: float = DEFAULT_MIN_CUTOFF,
        beta: float = DEFAULT_BETA,
        derivative_cutoff: float = DEFAULT_DERIVATIVE_CUTOFF,
    ) -> None:
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.derivative_cutoff = derivative_cutoff
        self._value = LowPass()
        self._derivative = LowPass()
        self._last_sample: float | None = None
        self._last_time: float | None = None

    def __call__(self, sample: float, timestamp: float) -> float:
        if self._last_time is None or timestamp <= self._last_time:
            self._last_time = timestamp
            self._last_sample = sample
            return self._value(sample, 1.0)

        dt = timestamp - self._last_time
        derivative = (sample - (self._last_sample or sample)) / dt
        smoothed_derivative = self._derivative(derivative, _alpha(self.derivative_cutoff, dt))

        cutoff = self.min_cutoff + self.beta * abs(smoothed_derivative)
        result = self._value(sample, _alpha(cutoff, dt))

        self._last_time = timestamp
        self._last_sample = sample
        return result


@dataclass
class SmoothingConfig:
    min_cutoff: float = DEFAULT_MIN_CUTOFF
    beta: float = DEFAULT_BETA
    #: Movement smaller than this (pixels) is ignored entirely.
    dead_zone_px: float = 12.0
    #: Ceiling on crop travel, in pixels per second.
    max_velocity_px_s: float = 260.0


def smooth_series(
    samples: list[tuple[float, float]], config: SmoothingConfig | None = None
) -> list[tuple[float, float]]:
    """Smooth ``(timestamp, value)`` samples through the full three-stage chain.

    Preconditions:
        samples are sorted by timestamp.
    """
    config = config or SmoothingConfig()
    if len(samples) <= 1:
        return list(samples)

    one_euro = OneEuroFilter(min_cutoff=config.min_cutoff, beta=config.beta)

    output: list[tuple[float, float]] = []
    held: float | None = None
    previous_time: float | None = None

    for timestamp, raw in samples:
        filtered = one_euro(raw, timestamp)

        if held is None:
            held = filtered
        else:
            # Dead zone: hold position until the target has moved meaningfully.
            if abs(filtered - held) >= config.dead_zone_px:
                target = filtered
                if previous_time is not None:
                    dt = max(1e-6, timestamp - previous_time)
                    max_step = config.max_velocity_px_s * dt
                    delta = target - held
                    if abs(delta) > max_step:
                        target = held + math.copysign(max_step, delta)
                held = target

        output.append((timestamp, held))
        previous_time = timestamp

    return output


# --------------------------------------------------------------------------
# Offline virtual-camera planner (stationary hold + smooth eased pans)
# --------------------------------------------------------------------------

#: Half-width tolerance band as a share of crop width: the speaker's face may
#: sway this far either side of crop centre without moving the camera at all.
CAMERA_BAND_RATIO = 0.22
#: Median window (seconds) removing detection jitter before hold planning.
CAMERA_SMOOTH_S = 0.8
#: Holds briefer than this join their neighbour instead of adding an extra pan.
CAMERA_MIN_HOLD_S = 1.2
#: Pan speed in crop-widths per second, bounded to feel deliberate and smooth.
CAMERA_PAN_SPEED = 0.75
CAMERA_PAN_MIN_S = 0.6
CAMERA_PAN_MAX_S = 1.4
#: Moves smaller than this fraction of crop width are ignored (stay locked).
CAMERA_MIN_MOVE_RATIO = 0.08
#: Intermediate points emitted per ease-in-out pan for piecewise-linear ffmpeg curves.
_PAN_STEPS = 8


def _median_window(values: list[float], window: int) -> list[float]:
    n = len(values)
    half = window // 2
    out: list[float] = []
    for i in range(n):
        sl = sorted(values[max(0, i - half) : min(n, i + half + 1)])
        out.append(sl[len(sl) // 2])
    return out


def _smoothstep(u: float) -> float:
    u = max(0.0, min(1.0, u))
    return u * u * (3.0 - 2.0 * u)


@dataclass
class _Hold:
    start: int
    end: int
    lo: float
    hi: float


def plan_camera_path(
    samples: list[tuple[float, float, float]],
    *,
    start_s: float,
    end_s: float,
    crop_w: float,
    crop_h: float,
    band_ratio: float = CAMERA_BAND_RATIO,
) -> list[tuple[float, float, float]]:
    """Plan a tripod-steady virtual-camera path from ``(t, x, y)`` crop targets.

    Within a shot, a seated speaker who sways naturally inside ``±band_ratio``
    of the crop width produces a single locked keyframe — zero jitter, zero
    micro-snaps. Only when the subject genuinely moves outside the framing band
    for at least ``CAMERA_MIN_HOLD_S`` does the camera execute a smooth cubic
    ease-in-out pan to the new hold position.
    """
    if not samples:
        return []
    if len(samples) < 3:
        mx = sorted(s[1] for s in samples)[len(samples) // 2]
        my = sorted(s[2] for s in samples)[len(samples) // 2]
        return [(start_s, mx, my)]

    times = [s[0] for s in samples]
    xs_raw = [s[1] for s in samples]
    ys_raw = [s[2] for s in samples]

    span = max(1e-3, times[-1] - times[0])
    est_fps = max(1.0, (len(samples) - 1) / span)
    smooth_win = max(1, round(CAMERA_SMOOTH_S * est_fps)) | 1

    xs = _median_window(xs_raw, smooth_win)
    ys = _median_window(ys_raw, smooth_win)

    band = max(24.0, band_ratio * crop_w)

    # 1. Split greedily into the fewest holds whose X positions fit within 2*band.
    holds: list[_Hold] = []
    h_start = 0
    lo = hi = xs[0]
    for i in range(1, len(xs)):
        n_lo = min(lo, xs[i])
        n_hi = max(hi, xs[i])
        if n_hi - n_lo > 2.0 * band:
            holds.append(_Hold(start=h_start, end=i, lo=lo, hi=hi))
            h_start = i
            lo = hi = xs[i]
        else:
            lo, hi = n_lo, n_hi
    holds.append(_Hold(start=h_start, end=len(xs), lo=lo, hi=hi))

    # 2. Absorb brief holds into their neighbour when combined excursion stays safe.
    min_frames = max(2, round(CAMERA_MIN_HOLD_S * est_fps))
    merged: list[_Hold] = []
    for hold in holds:
        if merged:
            prev = merged[-1]
            brief = (hold.end - hold.start) < min_frames or (prev.end - prev.start) < min_frames
            combined_range = max(prev.hi, hold.hi) - min(prev.lo, hold.lo)
            if brief and combined_range <= 3.0 * band:
                prev.end = hold.end
                prev.lo = min(prev.lo, hold.lo)
                prev.hi = max(prev.hi, hold.hi)
                continue
        merged.append(_Hold(hold.start, hold.end, hold.lo, hold.hi))

    def hold_feasible_x(hold: _Hold) -> tuple[float, float]:
        if hold.hi - hold.lo <= 2.0 * band:
            return hold.hi - band, hold.lo + band
        seg = sorted(xs[hold.start : hold.end])
        mid = seg[len(seg) // 2]
        return mid - band * 0.5, mid + band * 0.5

    def hold_center(hold: _Hold) -> tuple[float, float]:
        fx_lo, fx_hi = hold_feasible_x(hold)
        cx = (fx_lo + fx_hi) * 0.5
        seg_y = sorted(ys[hold.start : hold.end])
        cy = seg_y[len(seg_y) // 2]
        return cx, cy

    cur_x, cur_y = hold_center(merged[0])
    # Single hold (almost every seated podcast shot): lock completely static!
    if len(merged) == 1:
        return [(start_s, cur_x, cur_y)]

    # 3. Emit locked holds connected by smooth ease-in-out pans.
    keyframes: list[tuple[float, float, float]] = [(start_s, cur_x, cur_y)]
    busy_until = start_s
    min_move = max(24.0, CAMERA_MIN_MOVE_RATIO * crop_w)
    band_y = max(24.0, band_ratio * crop_h)

    for hold in merged[1:]:
        fx_lo, fx_hi = hold_feasible_x(hold)
        target_x, target_y = hold_center(hold)
        # Stay locked if current X already frames this hold comfortably.
        if fx_lo <= cur_x <= fx_hi and abs(target_y - cur_y) <= band_y:
            continue
        if abs(target_x - cur_x) < min_move and abs(target_y - cur_y) < band_y:
            continue

        dist_ratio = abs(target_x - cur_x) / max(1.0, crop_w)
        pan_s = min(CAMERA_PAN_MAX_S, max(CAMERA_PAN_MIN_S, dist_ratio / CAMERA_PAN_SPEED))
        change_t = times[min(hold.start, len(times) - 1)]
        pan_start = max(busy_until, change_t - pan_s * 0.5)
        pan_end = min(end_s, pan_start + pan_s)
        if pan_end - pan_start < 0.15:
            break

        # Hold flat right up to pan_start.
        if pan_start > keyframes[-1][0] + 1e-3:
            keyframes.append((pan_start, cur_x, cur_y))

        # Cubic ease-in-out curve from (cur_x, cur_y) -> (target_x, target_y).
        for step in range(1, _PAN_STEPS + 1):
            u = step / _PAN_STEPS
            e = _smoothstep(u)
            t = pan_start + (pan_end - pan_start) * u
            keyframes.append((t, cur_x + (target_x - cur_x) * e, cur_y + (target_y - cur_y) * e))

        cur_x, cur_y = target_x, target_y
        busy_until = pan_end

    if len(keyframes) == 1:
        return keyframes

    if keyframes[-1][0] < end_s - 1e-3:
        keyframes.append((end_s, cur_x, cur_y))
    return keyframes
