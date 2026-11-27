import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import {
  api,
  formatBytes,
  formatDuration,
  type CaptionStyle,
  type Clip,
  type CropPath,
  type IntroSettings,
  type Job,
  type OutroSettings,
  type Word,
} from '../api'
import { CaptionEditor } from '../components/CaptionEditor'
import { ClipPlayer } from '../components/ClipPlayer'
import { ErrorNote } from '../components/ErrorNote'
import { TrimBar } from '../components/TrimBar'

const RATIOS = ['9:16', '1:1', '16:9'] as const

export function Review() {
  const { jobId } = useParams()
  const [job, setJob] = useState<Job | null>(null)
  const [clips, setClips] = useState<Clip[]>([])
  const [styles, setStyles] = useState<CaptionStyle[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [words, setWords] = useState<Word[]>([])
  const [cropPath, setCropPath] = useState<CropPath | null>(null)
  const [wordsDirty, setWordsDirty] = useState(false)
  const [savingWords, setSavingWords] = useState(false)
  const [exporting, setExporting] = useState<Set<string>>(new Set())
  const [batchExport, setBatchExport] = useState<{
    kind: 'kept' | 'all'
    done: number
    total: number
  } | null>(null)
  const [batchFinishedCount, setBatchFinishedCount] = useState<number | null>(null)
  const [titleSaved, setTitleSaved] = useState(false)
  const [outroSettings, setOutroSettings] = useState<OutroSettings | null>(null)
  const [introSettings, setIntroSettings] = useState<IntroSettings | null>(null)
  const [includeOutro, setIncludeOutro] = useState(false)
  const [includeIntro, setIncludeIntro] = useState(false)
  const [introText, setIntroText] = useState('')
  const [includeWatermark, setIncludeWatermark] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!jobId) return
    void Promise.all([
      api.getJob(jobId),
      api.listClips(jobId),
      api.captionStyles(),
      api.getSettings().catch(() => null),
    ])
      .then(([loadedJob, loadedClips, loadedStyles, loadedSettings]) => {
        setJob(loadedJob)
        setClips(loadedClips)
        setStyles(loadedStyles)
        if (loadedSettings?.export?.outro) {
          setOutroSettings(loadedSettings.export.outro)
          setIncludeOutro(loadedSettings.export.outro.enabled)
        }
        if (loadedSettings?.export?.intro) {
          setIntroSettings(loadedSettings.export.intro)
          setIncludeIntro(loadedSettings.export.intro.enabled)
          setIncludeWatermark(loadedSettings.export.intro.watermark_enabled)
        }
        setSelectedId((current) => current ?? loadedClips[0]?.id ?? null)
      })
      .catch((err) => setError(err as Error))
  }, [jobId])

  const selected = useMemo(
    () => clips.find((clip) => clip.id === selectedId) ?? null,
    [clips, selectedId],
  )

  useEffect(() => {
    if (!selected) return
    setWordsDirty(false)
    setIntroText(selected.title || selected.hook || '')
    api
      .getClipWords(selected.id)
      .then(setWords)
      .catch(() => setWords([]))
    // 404 is expected for audio-only sources and jobs that never reframed; the
    // player falls back to a centre crop, matching what the renderer does.
    api
      .getCropPath(selected.id)
      .then(setCropPath)
      .catch(() => setCropPath(null))
  }, [selected?.id])

  const patchClip = useCallback((updated: Clip) => {
    setClips((current) => current.map((clip) => (clip.id === updated.id ? updated : clip)))
  }, [])

  const setStatus = async (clip: Clip, status: Clip['status']) => {
    try {
      patchClip(await api.patchClip(clip.id, { status }))
    } catch (err) {
      setError(err as Error)
    }
  }

  const commitTrim = async (start: number, end: number) => {
    if (!selected) return
    try {
      patchClip(await api.patchClip(selected.id, { start_s: start, end_s: end }))
      setWords(await api.getClipWords(selected.id))
    } catch (err) {
      setError(err as Error)
    }
  }

  const saveWords = async () => {
    if (!selected) return
    setSavingWords(true)
    try {
      patchClip(await api.patchCaptions(selected.id, { words }))
      setWordsDirty(false)
    } catch (err) {
      setError(err as Error)
    } finally {
      setSavingWords(false)
    }
  }

  const setStyle = async (clip: Clip, styleKey: string) => {
    try {
      patchClip(await api.patchCaptions(clip.id, { caption_style: styleKey }))
    } catch (err) {
      setError(err as Error)
    }
  }

  const setRatio = async (clip: Clip, ratio: string) => {
    try {
      patchClip(await api.patchCaptions(clip.id, { ratio }))
    } catch (err) {
      setError(err as Error)
    }
  }

  const commitTitle = async (clip: Clip, nextTitle: string) => {
    const cleaned = nextTitle.trim()
    if (!cleaned || cleaned === clip.title) return
    try {
      patchClip(await api.patchClip(clip.id, { title: cleaned }))
      setTitleSaved(true)
      window.setTimeout(() => setTitleSaved(false), 1800)
    } catch (err) {
      setError(err as Error)
    }
  }

  const exportClip = async (clip: Clip) => {
    setExporting((current) => new Set(current).add(clip.id))
    setError(null)
    try {
      // Auto-save edited caption words so users don't accidentally export stale text.
      if (clip.id === selectedId && wordsDirty) {
        patchClip(await api.patchCaptions(clip.id, { words }))
        setWordsDirty(false)
      }
      await api.exportClip(clip.id, clip.ratio, clip.caption_style, false, {
        includeOutro,
        includeIntro,
        introText: clip.id === selectedId ? introText : clip.title || clip.hook || '',
        includeWatermark,
      })
      patchClip(await api.getClip(clip.id))
    } catch (err) {
      setError(err as Error)
    } finally {
      setExporting((current) => {
        const next = new Set(current)
        next.delete(clip.id)
        return next
      })
    }
  }

  const exportBatch = async (targets: Clip[], kind: 'kept' | 'all') => {
    if (targets.length === 0 || batchExport) return
    setBatchFinishedCount(null)
    setBatchExport({ kind, done: 0, total: targets.length })
    try {
      for (let i = 0; i < targets.length; i += 1) {
        await exportClip(targets[i])
        setBatchExport({ kind, done: i + 1, total: targets.length })
      }
      setBatchFinishedCount(targets.length)
    } finally {
      setBatchExport(null)
    }
  }

  useEffect(() => {
    if (clips.length === 0) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        const idx = clips.findIndex((c) => c.id === selectedId)
        const next = clips[Math.min(clips.length - 1, idx + 1)]
        if (next) setSelectedId(next.id)
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        const idx = clips.findIndex((c) => c.id === selectedId)
        const prev = clips[Math.max(0, idx - 1)]
        if (prev) setSelectedId(prev.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clips, selectedId])

  const exportKept = () =>
    void exportBatch(
      clips.filter((clip) => clip.status === 'kept'),
      'kept',
    )

  const exportAll = () =>
    void exportBatch(
      clips.filter((clip) => clip.status !== 'discarded'),
      'all',
    )

  const resolvedWatermarkText =
    introSettings?.watermark_text?.trim() ||
    outroSettings?.youtube_handle?.trim() ||
    job?.source?.channel?.trim() ||
    ''

  const keptCount = clips.filter((clip) => clip.status === 'kept').length
  const exportableCount = clips.filter((clip) => clip.status !== 'discarded').length
  const exportedCount = clips.filter((clip) => clip.exports.length > 0).length
  const activeStyle = styles.find((style) => style.key === selected?.caption_style)

  if (error && clips.length === 0) {
    return (
      <div className="max-w-3xl pt-24">
        <ErrorNote error={error} />
      </div>
    )
  }

  if (!job) return <p className="pt-24 text-sm text-ink-500">Loading…</p>

  return (
    <div className="pt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-4 border-b border-ink-800 pb-5">
        <div className="min-w-0">
          <Link to="/" className="eyebrow transition-colors hover:text-sodium-500">
            ← All jobs
          </Link>
          <h1 className="mt-2 max-w-2xl truncate font-display text-[clamp(1.5rem,3vw,2.25rem)] leading-tight text-ink-100">
            {job.source?.title || 'Untitled'}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="numeric mr-2 text-xs text-ink-400">
            {clips.length} clips · {keptCount} kept · {exportedCount} exported
          </span>
          <button
            onClick={exportKept}
            disabled={keptCount === 0 || batchExport !== null}
            className="btn btn-ghost"
          >
            {batchExport?.kind === 'kept'
              ? `Exporting ${batchExport.done}/${batchExport.total}…`
              : `Export kept (${keptCount})`}
          </button>
          <button
            onClick={exportAll}
            disabled={exportableCount === 0 || batchExport !== null}
            className="btn btn-primary"
          >
            {batchExport?.kind === 'all'
              ? `Exporting ${batchExport.done}/${batchExport.total}…`
              : `Export all (${exportableCount})`}
          </button>
          {exportedCount > 0 && (
            <a
              href={api.jobExportsZipUrl(job.id)}
              download
              className="btn btn-ghost border-sodium-500/60 text-sodium-400 hover:border-sodium-400"
              title="Download all exported MP4 clips as a single ZIP archive"
            >
              <svg
                className="size-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <span>Download all ({exportedCount} .zip)</span>
            </a>
          )}
        </div>
      </div>

      {batchExport && (
        <div
          className="mt-5 border border-sodium-500/40 bg-ink-850/80 px-4 py-3"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-ink-100">
              Rendering clips ({batchExport.done} of {batchExport.total} completed)…
            </span>
            <span className="numeric text-sodium-500">
              {Math.round((batchExport.done / Math.max(1, batchExport.total)) * 100)}%
            </span>
          </div>
          <div className="mt-2 h-1 w-full overflow-hidden bg-ink-800">
            <div
              className="h-full bg-sodium-500 transition-all duration-300"
              style={{
                width: `${(batchExport.done / Math.max(1, batchExport.total)) * 100}%`,
              }}
            />
          </div>
        </div>
      )}

      {!batchExport && batchFinishedCount !== null && (
        <div
          className="mt-5 flex flex-wrap items-center justify-between gap-4 border border-signal-good/40 bg-signal-good/10 px-4 py-3 text-sm"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-2.5 text-ink-100">
            <span className="text-signal-good" aria-hidden="true">
              ✓
            </span>
            <span>
              <strong>{batchFinishedCount} clips</strong> finished rendering. Ready to download
              individually or as a ZIP bundle.
            </span>
          </div>
          <div className="flex items-center gap-3">
            <a href={api.jobExportsZipUrl(job.id)} download className="btn btn-primary">
              Download all (.zip)
            </a>
            <button
              type="button"
              onClick={() => setBatchFinishedCount(null)}
              className="btn btn-quiet text-xs"
              aria-label="Dismiss notification"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-6 max-w-3xl">
          <ErrorNote error={error} onDismiss={() => setError(null)} />
        </div>
      )}

      {clips.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="mt-8 grid gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,20rem)_minmax(0,26rem)_minmax(0,1fr)]">
          {/* Ranked list */}
          <section className="lg:max-h-[76vh] lg:overflow-y-auto lg:pr-1">
            <div className="flex items-baseline justify-between border-b border-ink-800 pb-2">
              <p className="eyebrow">Ranked</p>
              <span className="hidden text-[11px] text-ink-500 sm:inline">↑↓ or J/K</span>
            </div>
            <ul>
              {clips.map((clip, index) => (
                <li key={clip.id}>
                  <ClipRow
                    clip={clip}
                    index={index}
                    selected={clip.id === selectedId}
                    onSelect={() => setSelectedId(clip.id)}
                    onKeep={() =>
                      setStatus(clip, clip.status === 'kept' ? 'candidate' : 'kept')
                    }
                    onDiscard={() =>
                      setStatus(clip, clip.status === 'discarded' ? 'candidate' : 'discarded')
                    }
                  />
                </li>
              ))}
            </ul>
          </section>

          {/* Player + trim */}
          <section className="space-y-8">
            {selected && jobId && (
              <>
                <ClipPlayer
                  src={api.mediaUrl(jobId)}
                  startS={selected.start_s}
                  endS={selected.end_s}
                  words={words}
                  style={activeStyle}
                  ratio={selected.ratio}
                  cropPath={cropPath}
                  outro={
                    includeOutro && outroSettings
                      ? {
                          settings: outroSettings,
                          videoTitle: job.source?.title,
                          sourceChannel: job.source?.channel,
                        }
                      : null
                  }
                  introHook={
                    includeIntro && introText.trim()
                      ? {
                          text: introText,
                          durationS: introSettings?.duration_s ?? 3.0,
                          accentColor: outroSettings?.accent_color ?? '#FF0033',
                        }
                      : null
                  }
                  watermarkText={includeWatermark ? resolvedWatermarkText : null}
                />
                <TrimBar
                  words={words}
                  startS={selected.start_s}
                  endS={selected.end_s}
                  originalStart={selected.start_s}
                  originalEnd={selected.end_s}
                  onCommit={commitTrim}
                />
              </>
            )}
          </section>

          {/* Editor + style */}
          <section className="space-y-10">
            {selected && (
              <>
                <div>
                  <label className="block">
                    <div className="flex items-baseline justify-between">
                      <span className="eyebrow">Clip title &amp; Intro Hook</span>
                      {titleSaved && (
                        <span className="text-xs font-medium text-signal-good">Saved ✓</span>
                      )}
                    </div>
                    <input
                      type="text"
                      value={introText}
                      onChange={(e) => setIntroText(e.target.value)}
                      onBlur={() => void commitTitle(selected, introText)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.currentTarget.blur()
                        }
                      }}
                      placeholder="Edit clip title / intro hook…"
                      className="field mt-1.5 text-sm font-medium text-ink-100"
                    />
                    <span className="mt-1 block text-xs text-ink-500">
                      Press Enter or click outside to save — used for the Intro Hook banner and
                      export filename.
                    </span>
                  </label>

                  <p className="eyebrow mt-6">Why this clip</p>
                  <p className="mt-2 max-w-prose text-[0.9375rem] leading-relaxed text-ink-300">
                    {selected.reason || 'No rationale returned for this clip.'}
                  </p>
                  {selected.hook && (
                    <p className="mt-3 border-l-2 border-ink-700 pl-3 font-display text-lg italic text-ink-200">
                      “{selected.hook}”
                    </p>
                  )}
                </div>

                <CaptionEditor
                  words={words}
                  onChange={(next) => {
                    setWords(next)
                    setWordsDirty(true)
                  }}
                  onSave={saveWords}
                  saving={savingWords}
                  dirty={wordsDirty}
                />

                <div>
                  <p className="eyebrow border-b border-ink-800 pb-2">Caption style</p>
                  <div className="mt-3 space-y-1">
                    {styles.map((style) => (
                      <button
                        key={style.key}
                        onClick={() => setStyle(selected, style.key)}
                        className={[
                          'block w-full border-l-2 py-2 pl-3 text-left transition-colors duration-200',
                          style.key === selected.caption_style
                            ? 'border-sodium-500 bg-ink-850/60'
                            : 'border-transparent hover:border-ink-700 hover:bg-ink-850/30',
                        ].join(' ')}
                      >
                        <span className="text-sm text-ink-100">{style.label}</span>
                        <span className="mt-0.5 block text-xs leading-snug text-ink-500">
                          {style.description}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="eyebrow border-b border-ink-800 pb-2">Aspect ratio</p>
                  <div className="mt-3 flex gap-2">
                    {RATIOS.map((ratio) => (
                      <button
                        key={ratio}
                        onClick={() => setRatio(selected, ratio)}
                        className={[
                          'numeric btn',
                          ratio === selected.ratio ? 'btn-primary' : 'btn-ghost',
                        ].join(' ')}
                      >
                        {ratio}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="border-t border-ink-800 pt-6">
                  <div className="mb-4 space-y-2.5">
                    <div className="flex items-baseline justify-between">
                      <span className="eyebrow">Overlays</span>
                      <Link
                        to="/settings"
                        className="text-xs text-ink-500 underline underline-offset-4 hover:text-sodium-500"
                      >
                        configure
                      </Link>
                    </div>

                    <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink-200">
                      <input
                        type="checkbox"
                        checked={includeIntro}
                        onChange={(e) => setIncludeIntro(e.target.checked)}
                        className="size-4 accent-sodium-500"
                      />
                      Intro Hook banner ({introSettings?.duration_s ?? 3}s)
                    </label>

                    <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink-200">
                      <input
                        type="checkbox"
                        checked={includeWatermark}
                        onChange={(e) => setIncludeWatermark(e.target.checked)}
                        className="size-4 accent-sodium-500"
                      />
                      <span>
                        Channel watermark
                        {resolvedWatermarkText && (
                          <span className="ml-1.5 text-xs text-ink-500">
                            ({resolvedWatermarkText})
                          </span>
                        )}
                      </span>
                    </label>

                    <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink-200">
                      <input
                        type="checkbox"
                        checked={includeOutro}
                        onChange={(e) => setIncludeOutro(e.target.checked)}
                        className="size-4 accent-sodium-500"
                      />
                      YouTube CTA outro overlay
                    </label>
                  </div>

                  <button
                    onClick={() => exportClip(selected)}
                    disabled={exporting.has(selected.id)}
                    className="btn btn-primary w-full"
                  >
                    {exporting.has(selected.id) ? 'Rendering…' : 'Export this clip'}
                  </button>

                  {selected.exports.length > 0 && (
                    <ul className="mt-4 space-y-2">
                      {selected.exports.map((record) => (
                        <li key={record.id}>
                          <a
                            href={record.download_url}
                            download
                            className="flex items-center justify-between gap-3 border border-ink-800 bg-ink-850/60 px-3 py-2 text-xs transition-colors hover:border-sodium-500/60 hover:bg-ink-850"
                          >
                            <span className="flex items-center gap-2 font-medium text-sodium-400">
                              <svg
                                className="size-3.5 shrink-0"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                aria-hidden="true"
                              >
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                <polyline points="7 10 12 15 17 10" />
                                <line x1="12" y1="15" x2="12" y2="3" />
                              </svg>
                              Download {record.ratio} · {record.style}
                            </span>
                            <span className="numeric shrink-0 text-ink-400">
                              {formatBytes(record.size_bytes)}
                            </span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

function ClipRow({
  clip,
  index,
  selected,
  onSelect,
  onKeep,
  onDiscard,
}: {
  clip: Clip
  index: number
  selected: boolean
  onSelect: () => void
  onKeep: () => void
  onDiscard: () => void
}) {
  return (
    <div
      className={[
        'rise group grid cursor-pointer grid-cols-[2.25rem_1fr] gap-x-3 border-b border-l-2 border-b-ink-850 py-3 pl-2.5 transition-colors duration-200',
        selected
          ? 'border-l-sodium-500 bg-ink-850/85'
          : 'border-l-transparent hover:bg-ink-850/40',
        clip.status === 'discarded' ? 'opacity-40' : '',
      ].join(' ')}
      style={{ animationDelay: `${Math.min(index, 10) * 35}ms` }}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      {/* The score is the thing you scan by, so it gets the display face. */}
      <span
        className={[
          'numeric self-start font-display text-2xl leading-none',
          clip.score >= 85 ? 'text-sodium-500' : selected ? 'text-ink-200' : 'text-ink-500',
        ].join(' ')}
      >
        {clip.score}
      </span>

      <div className="min-w-0">
        <p className="truncate text-[0.9375rem] leading-snug text-ink-100">
          {clip.title || 'Untitled clip'}
        </p>
        <div className="mt-1.5 flex items-center gap-2.5">
          <span className="numeric text-xs text-ink-400">{formatDuration(clip.duration_s)}</span>
          {clip.user_trimmed && <span className="text-xs text-ink-500">trimmed</span>}
          {clip.exports.length > 0 && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-signal-good">
              <span className="size-1.5 rounded-full bg-signal-good" aria-hidden />
              exported
            </span>
          )}

          <span className="ml-auto flex items-center gap-1.5 pr-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onKeep()
              }}
              className={[
                'cursor-pointer px-2 py-0.5 text-xs font-medium transition-colors',
                clip.status === 'kept'
                  ? 'border border-signal-good/40 bg-signal-good/15 text-signal-good'
                  : 'text-ink-400 hover:bg-ink-800 hover:text-ink-100',
              ].join(' ')}
            >
              {clip.status === 'kept' ? '✓ kept' : 'keep'}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onDiscard()
              }}
              className="cursor-pointer px-2 py-0.5 text-xs text-ink-400 transition-colors hover:bg-ink-800 hover:text-signal-bad"
            >
              {clip.status === 'discarded' ? 'undo' : 'drop'}
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="max-w-xl pt-20">
      <h2 className="font-display text-3xl text-ink-200">No clips came back.</h2>
      <p className="mt-4 text-sm leading-relaxed text-ink-400">
        The model found nothing self-contained enough to stand alone — which is a real
        answer for some source material, not necessarily a failure.
      </p>
      <p className="mt-3 text-sm leading-relaxed text-ink-400">
        If you expected clips, try a larger provider model, or widen the length range so
        shorter moments qualify.
      </p>
    </div>
  )
}
