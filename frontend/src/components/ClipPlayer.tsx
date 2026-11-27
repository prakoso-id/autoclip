import { useCallback, useEffect, useRef, useState } from 'react'

import {
  formatTimecode,
  type CaptionStyle,
  type CropPath,
  type OutroSettings,
  type Word,
} from '../api'

const VOLUME_KEY = 'autoclip.volume'

/** Output shapes, matching autoclip.pipeline.export.RATIOS. */
const ASPECTS: Record<string, [number, number]> = {
  '9:16': [9, 16],
  '1:1': [1, 1],
  '16:9': [16, 9],
}

/** Tallest the preview may be, so the transport row stays on screen. */
const MAX_HEIGHT_VH = 62

function readStoredVolume(): number {
  const stored = Number(window.localStorage.getItem(VOLUME_KEY))
  return Number.isFinite(stored) && stored > 0 && stored <= 1 ? stored : 1
}

/**
 * 9:16 preview of one clip, with a CSS approximation of the burned captions.
 *
 * The approximation is deliberate: rendering the real ASS would mean shipping a
 * subtitle engine to the browser. What matters at review time is timing, word
 * grouping, and whether the style reads at all — the final look comes from
 * libass at export.
 */
export interface OutroPreviewConfig {
  settings: OutroSettings
  videoTitle?: string
  sourceChannel?: string | null
}

export function ClipPlayer({
  src,
  startS,
  endS,
  words,
  style,
  ratio,
  cropPath,
  outro,
}: {
  src: string
  startS: number
  endS: number
  words: Word[]
  style: CaptionStyle | undefined
  ratio: string
  cropPath?: CropPath | null
  outro?: OutroPreviewConfig | null
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(startS)
  const [volume, setVolume] = useState(readStoredVolume)
  const [muted, setMuted] = useState(false)
  const [nativeControls, setNativeControls] = useState(false)
  const [audioCheck, setAudioCheck] = useState<AudioCheck | null>(null)
  const [checking, setChecking] = useState(false)

  const runAudioCheck = async () => {
    const element = video.current
    if (!element) return
    setChecking(true)
    setAudioCheck(null)
    try {
      setAudioCheck(await measureOutputLevel(element))
    } catch (error) {
      setAudioCheck({ ok: false, peakDb: null, detail: String(error) })
    } finally {
      setChecking(false)
      setPlaying(!element.paused)
    }
  }

  // Kept in sync imperatively: volume and muted are element properties, not
  // attributes, so React won't apply them from JSX on later renders.
  useEffect(() => {
    const element = video.current
    if (!element) return
    element.volume = volume
    element.muted = muted
    window.localStorage.setItem(VOLUME_KEY, String(volume))
  }, [volume, muted])

  // Re-seek whenever the clip or its trim changes, so the preview always starts
  // where the export will.
  useEffect(() => {
    const element = video.current
    if (!element) return
    element.currentTime = startS
    setTime(startS)
    setPlaying(false)
    element.pause()
  }, [src, startS])

  const onTimeUpdate = useCallback(() => {
    const element = video.current
    if (!element) return
    if (element.currentTime >= endS) {
      element.pause()
      element.currentTime = startS
      setPlaying(false)
      setTime(startS)
      return
    }
    setTime(element.currentTime)
  }, [endS, startS])

  const toggle = () => {
    const element = video.current
    if (!element) return
    if (element.paused) {
      if (element.currentTime < startS || element.currentTime >= endS) {
        element.currentTime = startS
      }
      void element.play()
      setPlaying(true)
    } else {
      element.pause()
      setPlaying(false)
    }
  }

  const elapsed = Math.max(0, time - startS)
  const duration = Math.max(0.01, endS - startS)

  const rawOutroS = outro ? Math.min(outro.settings.duration_s, duration * 0.4) : 0
  const effOutroS = rawOutroS >= 0.5 ? rawOutroS : 0
  const outroStart = duration - effOutroS
  const outroFadeS = Math.min(0.35, effOutroS * 0.4)
  const outroSlideS = Math.min(0.45, effOutroS * 0.5)
  const outroElapsed = Math.max(0, elapsed - outroStart)
  const outroAlpha =
    effOutroS > 0 && elapsed >= outroStart
      ? Math.min(1, outroElapsed / Math.max(0.05, outroFadeS))
      : 0
  const slideProgress =
    effOutroS > 0 && elapsed >= outroStart
      ? Math.min(1, outroElapsed / Math.max(0.05, outroSlideS))
      : 0
  const outroSlidePx = Math.round(22 * Math.pow(1 - slideProgress, 3))

  const cropStyle = cropWindowStyle(cropPath, elapsed)
  const [aspectW, aspectH] = ASPECTS[ratio] ?? ASPECTS['9:16']
  // Height alone can't bound the box: with width:100% and an aspect-ratio, a
  // max-height clamp shortens the element without narrowing it, so the rendered
  // shape stops matching the ratio — a 9:16 preview ends up looking square.
  // Deriving a matching max-width makes the box shrink along both axes instead.
  const maxWidth = `${((MAX_HEIGHT_VH * aspectW) / aspectH).toFixed(3)}vh`

  return (
    <div className="mx-auto flex w-full flex-col items-stretch" style={{ maxWidth }}>
      <div
        className="relative w-full overflow-hidden bg-ink-850"
        style={{ aspectRatio: `${aspectW} / ${aspectH}` }}
        onClick={toggle}
        role="button"
        tabIndex={0}
        aria-label={playing ? 'Pause' : 'Play'}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault()
            toggle()
          }
        }}
      >
        <video
          ref={video}
          src={src}
          className={cropStyle ? 'absolute max-w-none' : 'size-full object-cover'}
          style={cropStyle ?? undefined}
          onTimeUpdate={onTimeUpdate}
          preload="auto"
          playsInline
          controls={nativeControls}
        />

        <div style={{ opacity: 1 - outroAlpha }}>
          <CaptionOverlay words={words} time={time} style={style} />
        </div>

        {outro && outroAlpha > 0 && (
          <OutroOverlay
            outro={outro}
            alpha={outroAlpha}
            slidePx={outroSlidePx}
            isPortrait={aspectH > aspectW}
          />
        )}

        {!playing && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <span className="grid size-16 place-items-center rounded-full bg-ink-900/70 pl-1 text-2xl text-ink-100 backdrop-blur-[2px]">
              ▶
            </span>
          </div>
        )}
      </div>

      <div className="mt-3 flex w-full items-center gap-4">
        <button onClick={toggle} className="btn btn-quiet -ml-1 w-14 justify-start">
          {playing ? 'Pause' : 'Play'}
        </button>

        <VolumeControl
          volume={volume}
          muted={muted}
          onVolume={(next) => {
            setVolume(next)
            // Dragging the slider up is an unambiguous "I want to hear this".
            if (next > 0) setMuted(false)
          }}
          onToggleMute={() => setMuted((current) => !current)}
        />

        <div className="h-px flex-1 bg-ink-800">
          <div
            className="h-px origin-left bg-sodium-500"
            style={{ transform: `scaleX(${elapsed / duration})` }}
          />
        </div>
        <span className="numeric text-xs text-ink-500">
          {formatTimecode(elapsed)} / {formatTimecode(duration)}
        </span>
      </div>

      {(muted || volume === 0) && (
        <p className="mt-2 text-xs text-sodium-500">
          Audio is muted — click the speaker to unmute.
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <button onClick={runAudioCheck} disabled={checking} className="btn btn-quiet -ml-1">
          {checking ? 'Listening…' : 'Test audio'}
        </button>
        <button
          onClick={() => setNativeControls((current) => !current)}
          className="btn btn-quiet"
        >
          {nativeControls ? 'Hide browser controls' : 'Browser controls'}
        </button>
      </div>

      {audioCheck && (
        <p
          className={`mt-1 max-w-prose text-xs leading-relaxed ${
            audioCheck.ok ? 'text-ink-400' : 'text-sodium-500'
          }`}
        >
          {audioCheck.detail}
        </p>
      )}
    </div>
  )
}

interface AudioCheck {
  ok: boolean
  peakDb: number | null
  detail: string
}

/**
 * Measure the real signal level leaving the video element.
 *
 * "Is it muted?" is otherwise unanswerable from inside the page: a muted tab, a
 * silenced app in the OS mixer, and audio routed to a disconnected output all
 * look identical, and none of them are distinguishable from a bug in here.
 *
 * ``captureStream`` taps the element's output rather than rerouting it, so
 * measuring cannot itself cause the silence being investigated. The analyser is
 * deliberately never connected to the context destination — doing so would play
 * the audio a second time.
 */
async function measureOutputLevel(element: HTMLVideoElement): Promise<AudioCheck> {
  const capture =
    (element as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream ??
    (element as HTMLVideoElement & { mozCaptureStream?: () => MediaStream }).mozCaptureStream

  if (!capture) {
    return {
      ok: false,
      peakDb: null,
      detail: "This browser can't measure audio output. Try the browser controls instead.",
    }
  }

  const wasPaused = element.paused
  if (wasPaused) await element.play()

  const stream = capture.call(element)
  const tracks = stream.getAudioTracks()
  if (tracks.length === 0) {
    if (wasPaused) element.pause()
    return {
      ok: false,
      peakDb: null,
      detail: 'This video exposes no audio track at all — that is a problem in AutoClip.',
    }
  }

  const context = new AudioContext()
  const analyser = context.createAnalyser()
  analyser.fftSize = 2048
  context.createMediaStreamSource(stream).connect(analyser)

  const samples = new Float32Array(analyser.fftSize)
  let peak = 0
  for (let i = 0; i < 24; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    analyser.getFloatTimeDomainData(samples)
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
  }

  await context.close()
  if (wasPaused) element.pause()

  if (peak <= 0.005) {
    return {
      ok: false,
      peakDb: null,
      detail:
        'No signal is leaving the player. Either the clip really is silent, or the ' +
        'player is muted — check the speaker icon above.',
    }
  }

  const peakDb = 20 * Math.log10(peak)
  return {
    ok: true,
    peakDb,
    detail:
      `Audio is leaving the player at ${peakDb.toFixed(1)} dBFS — the app is producing sound. ` +
      'If you still hear nothing, it is between the browser and your speakers: right-click ' +
      'this tab and check for "Unmute site", then check Windows Volume Mixer and your ' +
      'output device.',
  }
}

/**
 * Position the source video so the preview box shows the crop the renderer will.
 *
 * Everything is expressed as a percentage of the crop window, which makes it
 * independent of how large the preview happens to be drawn. Returns null when
 * there is no crop path — the caller then falls back to a centre crop, which is
 * what the renderer does in that case too.
 */
function cropWindowStyle(
  cropPath: CropPath | null | undefined,
  elapsed: number,
): React.CSSProperties | null {
  if (!cropPath || cropPath.segments.length === 0) return null

  const segment =
    cropPath.segments.find((s) => elapsed >= s.start_s && elapsed < s.end_s) ??
    cropPath.segments[cropPath.segments.length - 1]

  // A fitted segment shows the whole frame over a blur rather than cropping.
  // Letting it fall through to object-contain is closer than any crop would be.
  if (segment.fit) return null

  const { x, y } = interpolate(segment.keyframes, elapsed)
  const { source_width: sourceW, source_height: sourceH } = cropPath

  return {
    width: `${(sourceW / segment.width) * 100}%`,
    height: `${(sourceH / segment.height) * 100}%`,
    left: `${(-x / segment.width) * 100}%`,
    top: `${(-y / segment.height) * 100}%`,
  }
}

/** Piecewise-linear lookup, matching croppath.axis_expression on the server. */
function interpolate(
  keyframes: { t: number; x: number; y: number }[],
  t: number,
): { x: number; y: number } {
  if (keyframes.length === 0) return { x: 0, y: 0 }
  if (keyframes.length === 1) return { x: keyframes[0].x, y: keyframes[0].y }

  if (t <= keyframes[0].t) return { x: keyframes[0].x, y: keyframes[0].y }
  const last = keyframes[keyframes.length - 1]
  if (t >= last.t) return { x: last.x, y: last.y }

  for (let i = 0; i < keyframes.length - 1; i += 1) {
    const a = keyframes[i]
    const b = keyframes[i + 1]
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t
      const ratio = span > 0 ? (t - a.t) / span : 0
      return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio }
    }
  }

  return { x: last.x, y: last.y }
}

/**
 * Mute toggle and volume slider.
 *
 * Not optional chrome: without it there is no way to see whether the preview is
 * silent because it's muted or because something upstream is wrong, and no way
 * to do anything about it. The slider stays visible rather than hiding behind a
 * hover, because "is this thing muted?" is a question you ask at a glance.
 */
function VolumeControl({
  volume,
  muted,
  onVolume,
  onToggleMute,
}: {
  volume: number
  muted: boolean
  onVolume: (value: number) => void
  onToggleMute: () => void
}) {
  const silent = muted || volume === 0

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onToggleMute}
        className={`btn btn-quiet px-1 ${silent ? 'text-sodium-500' : ''}`}
        aria-label={silent ? 'Unmute' : 'Mute'}
        title={silent ? 'Unmute' : 'Mute'}
      >
        <SpeakerIcon silent={silent} level={volume} />
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={silent ? 0 : volume}
        onChange={(e) => onVolume(Number(e.target.value))}
        aria-label="Volume"
        className="h-1 w-20 cursor-pointer appearance-none rounded-full bg-ink-700 accent-sodium-500"
      />
    </div>
  )
}

function SpeakerIcon({ silent, level }: { silent: boolean; level: number }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M11 5 6 9H3v6h3l5 4V5Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {silent ? (
        <path
          d="m16 9 5 6m0-6-5 6"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      ) : (
        <>
          <path
            d="M15.5 9.5a3.5 3.5 0 0 1 0 5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          {level > 0.5 && (
            <path
              d="M18.5 7a7 7 0 0 1 0 10"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          )}
        </>
      )}
    </svg>
  )
}

/** Distinct speaker highlight palette matching autoclip.pipeline.captions.SPEAKER_PALETTE. */
export const SPEAKER_PALETTE = [
  '#FFE500',
  '#00E5FF',
  '#4ADE80',
  '#FF6B6B',
  '#C084FC',
  '#FB923C',
] as const

export const SPEAKER_BASE_PALETTE = [
  '#FFFFFF',
  '#A5F3FC',
  '#BBF7D0',
  '#FECDD3',
  '#E9D5FF',
  '#FED7AA',
] as const

export function buildSpeakerColorMap(
  words: Word[],
  palette: readonly string[] = SPEAKER_PALETTE,
): Map<string, string> {
  const seen: string[] = []
  for (const word of words) {
    if (word.speaker && !seen.includes(word.speaker)) {
      seen.push(word.speaker)
    }
  }
  const map = new Map<string, string>()
  if (seen.length < 2) return map
  seen.forEach((speaker, idx) => {
    map.set(speaker, palette[idx % palette.length])
  })
  return map
}

/** Group words the way the ASS generator does, then show the active group. */
function CaptionOverlay({
  words,
  time,
  style,
}: {
  words: Word[]
  time: number
  style: CaptionStyle | undefined
}) {
  if (!style || words.length === 0) return null

  const groups = groupWords(words, style.preview.maxWords)
  const active = groups.find((group) => time >= group[0].start && time <= group[group.length - 1].end)
  if (!active) return null

  const speakerColors = buildSpeakerColorMap(words, SPEAKER_PALETTE)
  const speakerBaseColors = buildSpeakerColorMap(words, SPEAKER_BASE_PALETTE)
  const { primary, accent, allCaps, outlineWidth, boxed, marginRatio, sizeRatio } = style.preview

  return (
    <div
      className="pointer-events-none absolute inset-x-0 flex justify-center px-[6%]"
      style={{ bottom: `${marginRatio * 100}%` }}
    >
      <p
        className="text-center leading-[1.15]"
        style={{
          fontFamily: style.preview.font === 'Anton' ? 'Anton, Impact, sans-serif' : undefined,
          fontSize: `clamp(0.75rem, ${sizeRatio * 100}cqh, 4rem)`,
          fontWeight: boxed || style.preview.font === 'Anton' ? 400 : 600,
          textTransform: allCaps ? 'uppercase' : 'none',
          color: primary,
          textShadow: boxed
            ? undefined
            : `0 0 ${outlineWidth}px #000, 0 0 ${outlineWidth * 2}px #000`,
          background: boxed ? 'rgba(0,0,0,0.78)' : undefined,
          padding: boxed ? '0.15em 0.4em' : undefined,
        }}
      >
        {active.map((word, index) => {
          const isActive = time >= word.start && time <= word.end
          const wordAccent = (word.speaker && speakerColors.get(word.speaker)) || accent
          const wordBase = (word.speaker && speakerBaseColors.get(word.speaker)) || primary
          return (
            <span
              key={`${word.start}-${index}`}
              style={{
                color: isActive && wordAccent ? wordAccent : wordBase,
                display: 'inline-block',
                transform: isActive && wordAccent ? 'scale(1.08)' : undefined,
                transition: 'transform 120ms cubic-bezier(0.16,1,0.3,1)',
                marginInline: '0.14em',
              }}
            >
              {allCaps ? word.text.toUpperCase() : word.text}
            </span>
          )
        })}
      </p>
    </div>
  )
}

function groupWords(words: Word[], maxWords: number): Word[][] {
  const groups: Word[][] = []
  let current: Word[] = []

  for (const [index, word] of words.entries()) {
    if (current.length > 0) {
      const prev = current[current.length - 1]
      const gap = word.start - prev.end
      const speakerChanged = Boolean(prev.speaker && word.speaker && word.speaker !== prev.speaker)
      if (speakerChanged || gap > 0.4 || current.length >= maxWords) {
        groups.push(current)
        current = []
      }
    }
    current.push(word)
    if (/[.!?…]$/.test(word.text.trim()) && index !== words.length - 1) {
      groups.push(current)
      current = []
    }
  }
  if (current.length > 0) groups.push(current)
  return groups
}

function formatHandle(raw: string): string {
  const cleaned = raw.trim()
  if (!cleaned) return ''
  return cleaned.startsWith('@') ? cleaned : `@${cleaned}`
}

/** Live-blurred YouTube Search Bar CTA preview layered on top of the playing clip tail. */
function OutroOverlay({
  outro,
  alpha,
  slidePx,
  isPortrait,
}: {
  outro: OutroPreviewConfig
  alpha: number
  slidePx: number
  isPortrait: boolean
}) {
  const { settings, videoTitle, sourceChannel } = outro
  const accent = settings.accent_color || '#FF0033'
  const ctaRaw = (settings.cta_text.trim() || 'Tonton selengkapnya di YouTube').toUpperCase()
  const words = ctaRaw.split(/\s+/)
  const splitIdx = words.length >= 3 ? Math.ceil(words.length * 0.6) : words.length
  const line1 = words.slice(0, splitIdx).join(' ')
  const line2 = words.slice(splitIdx).join(' ')

  const showTitle = settings.show_video_title && Boolean(videoTitle?.trim())
  const searchQuery = settings.youtube_handle.trim() || (sourceChannel ?? '').trim() || 'YouTube'
  const ig = formatHandle(settings.instagram_handle)
  const tt = formatHandle(settings.tiktok_handle)

  return (
    <div
      className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-[11%] text-center"
      style={{
        opacity: alpha,
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        background: 'rgba(8,10,16,0.58)',
        paddingBottom: isPortrait ? '14%' : '0',
      }}
    >
      <div
        className="flex w-full flex-col items-center"
        style={{ transform: `translateY(${slidePx}px)` }}
      >
        {/* YouTube logo lockup */}
        <div className="inline-flex items-center gap-1.5">
          <span
            className="inline-flex h-5 w-7 items-center justify-center rounded-md text-[9px] text-white shadow-sm"
            style={{ backgroundColor: accent }}
          >
            ▶
          </span>
          <span className="text-sm font-extrabold tracking-tight text-white">YouTube</span>
        </div>

        {/* Dual-tone headline */}
        <p
          className="mt-2.5 leading-[1.04] text-white uppercase drop-shadow-[0_2px_8px_rgba(0,0,0,0.65)]"
          style={{
            fontFamily: 'Anton, Impact, sans-serif',
            fontSize: isPortrait ? 'clamp(1.2rem, 4.8vw, 1.7rem)' : 'clamp(1.05rem, 3.2vw, 1.45rem)',
          }}
        >
          <span className="block">{line1}</span>
          {line2 && (
            <span className="block" style={{ color: '#FFD60A' }}>
              {line2}
            </span>
          )}
        </p>

        {/* Elevated white YouTube Search Bar */}
        <div className="mt-3.5 flex w-full items-center justify-between rounded-full bg-white py-1 pl-3 pr-1 shadow-[0_8px_24px_rgba(0,0,0,0.45)]">
          <div className="flex min-w-0 items-center gap-2">
            <svg
              viewBox="0 0 24 24"
              className="size-3.5 shrink-0 text-slate-800"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="20" y1="20" x2="16.5" y2="16.5" />
            </svg>
            <span className="truncate text-[11px] font-bold text-slate-900">{searchQuery}</span>
            <span className="h-3.5 w-[1.5px] shrink-0" style={{ backgroundColor: accent }} />
          </div>
          <span
            className="ml-2 inline-flex h-6 w-9 shrink-0 items-center justify-center rounded-full text-white"
            style={{ backgroundColor: accent }}
          >
            <svg
              viewBox="0 0 24 24"
              className="size-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="20" y1="20" x2="16.5" y2="16.5" />
            </svg>
          </span>
        </div>

        {/* Clean floating title (2A) or concise cue (2B) */}
        {showTitle ? (
          <>
            <p className="mt-3 line-clamp-2 max-w-[95%] text-[10px] font-semibold leading-snug text-slate-100/95">
              “{videoTitle}”
            </p>
            <p className="mt-1.5 text-[9.5px] font-bold" style={{ color: '#FFD60A' }}>
              Link video full di bio / deskripsi →
            </p>
          </>
        ) : (
          <p className="mt-2.5 text-[9.5px] font-semibold text-slate-200/90">
            Cari channel di atas · atau klik link di bio →
          </p>
        )}

        {/* Optional social icon pills */}
        {(ig || tt) && (
          <>
            <div className="mt-3 h-px w-10 bg-white/25" />
            <p className="mt-1.5 text-[8px] font-semibold tracking-wider text-slate-300/80">
              FOLLOW JUGA DI
            </p>
            <div className="mt-1.5 flex flex-wrap justify-center gap-1.5">
              {ig && (
                <span className="inline-flex items-center gap-1 rounded-full border border-white/25 bg-white/10 px-2.5 py-0.5 text-[9.5px] font-semibold text-slate-100">
                  IG {ig}
                </span>
              )}
              {tt && (
                <span className="inline-flex items-center gap-1 rounded-full border border-white/25 bg-white/10 px-2.5 py-0.5 text-[9.5px] font-semibold text-slate-100">
                  TikTok {tt}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
