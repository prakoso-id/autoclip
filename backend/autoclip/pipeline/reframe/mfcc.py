"""MFCC feature extraction for the LR-ASD active speaker model.

Reproduces ``python_speech_features.mfcc`` default settings bit-for-bit:
13 cepstra, 26 mel filters, 512-point FFT, 0.97 pre-emphasis, rectangular
window, ceplifter 22, and log frame energy replacing c0.

LR-ASD expects 25 ms windows with a 10 ms step at 16 kHz mono audio so that
four audio feature frames align with every 25 fps video frame.
"""

from __future__ import annotations

import math
from functools import lru_cache

import numpy as np

MFCC_COEFFS = 13
_NFFT = 512
_NFILT = 26
_PREEMPH = 0.97
_CEPLIFTER = 22


def _hz_to_mel(hz: np.ndarray | float) -> np.ndarray | float:
    return 2595.0 * np.log10(1.0 + hz / 700.0)


def _mel_to_hz(mel: np.ndarray | float) -> np.ndarray | float:
    return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)


@lru_cache(maxsize=8)
def _filterbank(sample_rate: int) -> np.ndarray:
    """Triangular mel filterbank of shape ``(_NFILT, _NFFT // 2 + 1)``."""
    low_mel = float(_hz_to_mel(0.0))
    high_mel = float(_hz_to_mel(sample_rate / 2.0))
    mel_points = np.linspace(low_mel, high_mel, _NFILT + 2, dtype=np.float64)
    bins = np.floor((_NFFT + 1) * _mel_to_hz(mel_points) / sample_rate).astype(np.int64)

    bank = np.zeros((_NFILT, _NFFT // 2 + 1), dtype=np.float64)
    for j in range(_NFILT):
        left, center, right = int(bins[j]), int(bins[j + 1]), int(bins[j + 2])
        if center > left:
            for i in range(left, center):
                bank[j, i] = (i - left) / (center - left)
        if right > center:
            for i in range(center, right):
                bank[j, i] = (right - i) / (right - center)
    return bank


@lru_cache(maxsize=1)
def _dct_matrix() -> np.ndarray:
    """Orthonormal DCT-II matrix of shape ``(MFCC_COEFFS, _NFILT)``."""
    k = np.arange(MFCC_COEFFS, dtype=np.float64)[:, None]
    n = np.arange(_NFILT, dtype=np.float64)[None, :]
    scales = np.where(k == 0, math.sqrt(1.0 / (4 * _NFILT)), math.sqrt(1.0 / (2 * _NFILT)))
    return 2.0 * scales * np.cos(math.pi * k * (2.0 * n + 1.0) / (2.0 * _NFILT))


@lru_cache(maxsize=1)
def _lifter() -> np.ndarray:
    idx = np.arange(MFCC_COEFFS, dtype=np.float64)
    return 1.0 + (_CEPLIFTER / 2.0) * np.sin(math.pi * idx / _CEPLIFTER)


def compute_mfcc(
    pcm: np.ndarray,
    sample_rate: int = 16_000,
    *,
    winlen: float = 0.025,
    winstep: float = 0.010,
) -> np.ndarray:
    """Compute MFCC features from 16-bit mono PCM.

    Returns a float32 array of shape ``(num_frames, 13)``.
    """
    signal = np.asarray(pcm, dtype=np.float64).reshape(-1)
    if signal.size == 0:
        return np.zeros((0, MFCC_COEFFS), dtype=np.float32)

    frame_len = round(winlen * sample_rate)
    frame_step = round(winstep * sample_rate)
    eps = float(np.finfo(np.float64).eps)

    # Pre-emphasis filter matching python_speech_features.sigproc.preemphasis.
    pre = np.empty_like(signal)
    pre[0] = signal[0]
    if signal.size > 1:
        pre[1:] = signal[1:] - _PREEMPH * signal[:-1]

    slen = pre.size
    num_frames = 1 if slen <= frame_len else 1 + math.ceil((slen - frame_len) / frame_step)
    pad_len = (num_frames - 1) * frame_step + frame_len
    if pad_len > slen:
        pre = np.pad(pre, (0, pad_len - slen), mode="constant")

    # Build strided frame view without copying until FFT zero-padding.
    stride = pre.strides[0]
    frames = np.lib.stride_tricks.as_strided(
        pre, shape=(num_frames, frame_len), strides=(frame_step * stride, stride)
    )

    spec = np.fft.rfft(frames, n=_NFFT, axis=1)
    pspec = (spec.real * spec.real + spec.imag * spec.imag) / _NFFT

    energy = np.sum(pspec, axis=1)
    energy = np.where(energy == 0.0, eps, energy)

    fb = _filterbank(sample_rate)
    fbank = pspec @ fb.T
    fbank = np.where(fbank == 0.0, eps, fbank)
    fbank_log = np.log(fbank)

    dct = _dct_matrix()
    cepstra = (fbank_log @ dct.T) * _lifter()[None, :]
    cepstra[:, 0] = np.log(energy)

    return cepstra.astype(np.float32)
