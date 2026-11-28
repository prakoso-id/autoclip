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
      <div className="max-w-3xl pt-12">
        <ErrorNote error={error} />
      </div>
    )
  }

  if (!job) return <p className="pt-12 text-sm text-[#737168]">Loading studio…</p>

  const latestExport = selected?.exports[0] ?? null

  return (
    <div className="space-y-5">
      {/* Top Studio Header Card */}
      <div className="studio-card flex flex-wrap items-center justify-between gap-4 px-6 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link
              to="/"
              className="numeric text-xs font-bold uppercase tracking-wider text-[#E11D48] hover:underline"
            >
              ← All Sessions
            </Link>
            <span className="text-xs text-[#D2CFC6]">•</span>
            <span className="numeric text-xs font-medium text-[#737168]">
              {clips.length} Clips · {keptCount} Kept · {exportedCount} MP4
            </span>
          </div>
          <h1 className="mt-1 max-w-2xl truncate text-xl font-extrabold tracking-tight text-[#171715]">
            {job.source?.title || 'Untitled Episode'}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={exportKept}
            disabled={keptCount === 0 || batchExport !== null}
            className="btn btn-ghost"
          >
            {batchExport?.kind === 'kept'
              ? `Exporting ${batchExport.done}/${batchExport.total}…`
              : `Export Kept (${keptCount})`}
          </button>
          <button
            type="button"
            onClick={exportAll}
            disabled={exportableCount === 0 || batchExport !== null}
            className="btn btn-primary"
          >
            {batchExport?.kind === 'all'
              ? `Exporting ${batchExport.done}/${batchExport.total}…`
              : `Export All (${exportableCount} Clips)`}
          </button>
          {exportedCount > 0 && (
            <a
              href={api.jobExportsZipUrl(job.id)}
              download
              className="btn btn-dark"
              title="Download all rendered MP4 clips as a single ZIP archive"
            >
              <span>⬇ Download All (.ZIP)</span>
            </a>
          )}
        </div>
      </div>

      {/* Live Batch Export Progress / Completion Banner */}
      {batchExport && (
        <div
          className="studio-card border-[#FECDD3] bg-[#FFF1F2] px-5 py-3.5"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center justify-between text-xs font-bold text-[#9F1239]">
            <span>
              Rendering clips ({batchExport.done} of {batchExport.total} completed)…
            </span>
            <span className="numeric">
              {Math.round((batchExport.done / Math.max(1, batchExport.total)) * 100)}%
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#FECDD3]">
            <div
              className="h-full bg-[#E11D48] transition-all duration-300"
              style={{
                width: `${(batchExport.done / Math.max(1, batchExport.total)) * 100}%`,
              }}
            />
          </div>
        </div>
      )}

      {!batchExport && batchFinishedCount !== null && (
        <div
          className="studio-card flex flex-wrap items-center justify-between gap-4 border-[#A7F3D0] bg-[#ECFDF5] px-5 py-3.5 text-sm"
          role="status"
          aria-live="polite"
        >
          <div className="font-semibold text-[#065F46]">
            ✓ {batchFinishedCount} clips finished rendering. Ready to download individually or as a
            ZIP bundle.
          </div>
          <div className="flex items-center gap-2.5">
            <a href={api.jobExportsZipUrl(job.id)} download className="btn btn-dark">
              ⬇ Download All (.ZIP)
            </a>
            <button
              type="button"
              onClick={() => setBatchFinishedCount(null)}
              className="btn btn-quiet text-xs"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {error && <ErrorNote error={error} onDismiss={() => setError(null)} />}

      {clips.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[340px_430px_1fr]">
          {/* COLUMN 1: Ranked Highlights with Thumbnail Cards */}
          <section className="studio-card flex flex-col p-4 lg:max-h-[calc(100vh-148px)]">
            <div className="mb-3 flex items-center justify-between px-1">
              <span className="text-sm font-bold text-[#171715]">
                Ranked Highlights ({clips.length})
              </span>
              <span className="numeric text-xs text-[#737168]">
                {keptCount} Kept · {exportedCount} MP4
              </span>
            </div>

            <ul className="space-y-2 overflow-y-auto pr-1">
              {clips.map((clip, index) => (
                <li key={clip.id}>
                  <ClipCard
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

          {/* COLUMN 2: High-Contrast Dark Theater Stage */}
          <section className="flex flex-col justify-between rounded-[20px] bg-[#141413] p-5 text-white shadow-md">
            {selected && jobId && (
              <>
                <div className="mb-3 flex items-center justify-between text-xs text-[#A1A09A]">
                  <span className="numeric font-semibold tracking-wider">
                    PREVIEW {selected.ratio} · 1080P
                  </span>
                  <span className="numeric flex items-center gap-1.5 font-semibold text-[#FB7185]">
                    <span className="size-1.5 rounded-full bg-[#F43F5E]" />
                    LIVE OVERLAYS
                  </span>
                </div>

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

                <div className="mt-4 rounded-xl border border-[#2E2E2B] bg-[#1E1E1C] p-3">
                  <TrimBar
                    words={words}
                    startS={selected.start_s}
                    endS={selected.end_s}
                    originalStart={selected.start_s}
                    originalEnd={selected.end_s}
                    onCommit={commitTrim}
                  />
                </div>
              </>
            )}
          </section>

          {/* COLUMN 3: Inspector, Overlays & Speaker Dialogue */}
          <section className="studio-card flex flex-col justify-between gap-5 p-5">
            {selected && (
              <>
                <div className="space-y-5">
                  {/* Intro Hook Headline Input */}
                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="eyebrow">
                        Intro Hook Headline (First {introSettings?.duration_s ?? 3}s)
                      </span>
                      <span className="text-xs font-bold text-[#059669]">
                        {titleSaved ? '✓ Saved' : '✓ Auto-saved'}
                      </span>
                    </div>
                    <input
                      type="text"
                      value={introText}
                      onChange={(e) => setIntroText(e.target.value)}
                      onBlur={() => void commitTitle(selected, introText)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur()
                      }}
                      placeholder="Edit clip title / intro hook…"
                      className="w-full rounded-xl border-[1.5px] border-[#171715] bg-[#FAF9F6] px-3.5 py-2.5 text-[14.5px] font-bold text-[#171715] outline-none transition-colors focus:bg-white"
                    />
                  </div>

                  {/* 3 Tactile Overlay Toggle Pills */}
                  <div className="grid grid-cols-3 gap-2.5">
                    <OverlayPill
                      label="Intro Hook"
                      active={includeIntro}
                      onToggle={() => setIncludeIntro((v) => !v)}
                    />
                    <OverlayPill
                      label="@Watermark"
                      active={includeWatermark}
                      onToggle={() => setIncludeWatermark((v) => !v)}
                    />
                    <OverlayPill
                      label="YT Outro"
                      active={includeOutro}
                      onToggle={() => setIncludeOutro((v) => !v)}
                    />
                  </div>

                  {/* Compact Caption Style + Aspect Ratio Row */}
                  <div className="grid gap-3 rounded-xl border border-[#EAE8E1] bg-[#FAF9F6] p-3 sm:grid-cols-[1fr_auto]">
                    <label className="block">
                      <span className="eyebrow block">Caption Style</span>
                      <select
                        value={selected.caption_style}
                        onChange={(e) => void setStyle(selected, e.target.value)}
                        className="mt-1 w-full cursor-pointer rounded-lg border border-[#D8D5CC] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#171715]"
                      >
                        {styles.map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.label} — {s.description}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div>
                      <span className="eyebrow block">Aspect Ratio</span>
                      <div className="mt-1 flex gap-1">
                        {RATIOS.map((ratio) => (
                          <button
                            key={ratio}
                            type="button"
                            onClick={() => void setRatio(selected, ratio)}
                            className={[
                              'numeric cursor-pointer rounded-lg px-2.5 py-1.5 text-xs font-bold transition-colors',
                              ratio === selected.ratio
                                ? 'bg-[#171715] text-white'
                                : 'border border-[#D8D5CC] bg-white text-[#57564F] hover:text-[#171715]',
                            ].join(' ')}
                          >
                            {ratio}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Speaker Dialogue Editor */}
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

                  {selected.reason && (
                    <p className="rounded-xl border border-[#EAE8E1] bg-[#FAF9F6] px-3.5 py-2.5 text-xs leading-relaxed text-[#57564F]">
                      <strong className="text-[#171715]">Why selected:</strong> {selected.reason}
                    </p>
                  )}
                </div>

                {/* Bottom Render & Download Row */}
                <div className="flex flex-wrap items-center gap-2.5 border-t border-[#EAE8E1] pt-4">
                  <button
                    type="button"
                    onClick={() => void exportClip(selected)}
                    disabled={exporting.has(selected.id)}
                    className="btn btn-primary flex-1 py-3 text-sm"
                  >
                    {exporting.has(selected.id) ? 'Rendering Clip…' : 'Render This Clip'}
                  </button>

                  {latestExport && (
                    <a
                      href={latestExport.download_url}
                      download
                      className="btn btn-ghost py-3 text-xs font-bold"
                    >
                      ⬇ MP4 ({formatBytes(latestExport.size_bytes)})
                    </a>
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

function OverlayPill({
  label,
  active,
  onToggle,
}: {
  label: string
  active: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={[
        'flex cursor-pointer items-center justify-between rounded-xl border px-3 py-2.5 text-xs font-bold transition-all',
        active
          ? 'border-[#FECDD3] bg-[#FFF1F2] text-[#171715]'
          : 'border-[#E2E0D8] bg-[#FAF9F6] text-[#737168] hover:border-[#D0CEC4]',
      ].join(' ')}
    >
      <span className="truncate">{label}</span>
      <span className={active ? 'text-[#E11D48]' : 'text-[#8C8A80]'}>
        {active ? 'ON' : 'OFF'}
      </span>
    </button>
  )
}

function ClipCard({
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
  const [thumbFailed, setThumbFailed] = useState(false)
  const latestExport = clip.exports[0] ?? null

  return (
    <div
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
      style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}
      className={[
        'rise grid cursor-pointer grid-cols-[56px_1fr] gap-3 rounded-xl border p-2.5 transition-all',
        selected
          ? 'border-[#FECDD3] bg-[#FFF1F2] shadow-2xs'
          : 'border-[#ECEAE2] bg-white hover:border-[#D8D5CC] hover:bg-[#FAF9F6]',
        clip.status === 'discarded' ? 'opacity-45' : '',
      ].join(' ')}
    >
      {/* 9:16 Vertical Thumbnail with Score Badge */}
      <div className="relative h-[88px] w-[56px] overflow-hidden rounded-lg bg-[#171715]">
        {!thumbFailed && (
          <img
            src={api.clipThumbnailUrl(clip.id)}
            alt=""
            loading="lazy"
            onError={() => setThumbFailed(true)}
            className="size-full object-cover"
          />
        )}
        <span
          className={[
            'numeric absolute left-1 top-1 rounded px-1.5 py-0.5 text-[10px] font-extrabold leading-none text-white shadow-xs',
            selected || clip.score >= 88 ? 'bg-[#E11D48]' : 'bg-[#171715]/85',
          ].join(' ')}
        >
          {clip.score}
        </span>
      </div>

      <div className="flex min-w-0 flex-col justify-between py-0.5">
        <p className="line-clamp-2 text-[13.5px] font-bold leading-snug text-[#171715]">
          {clip.title || 'Untitled clip'}
        </p>

        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="numeric truncate text-[11.5px] font-medium text-[#57564F]">
            {formatDuration(clip.duration_s)}
            {latestExport ? ` · ${formatBytes(latestExport.size_bytes)}` : ''}
          </span>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onKeep()
              }}
              className={[
                'cursor-pointer rounded-md px-2 py-0.5 text-[11px] font-bold transition-colors',
                clip.status === 'kept'
                  ? 'bg-[#D1FAE5] text-[#065F46]'
                  : 'border border-[#DCD9D0] bg-white text-[#57564F] hover:border-[#171715] hover:text-[#171715]',
              ].join(' ')}
            >
              {clip.status === 'kept' ? '✓ Kept' : 'Keep'}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onDiscard()
              }}
              className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] font-medium text-[#737168] hover:bg-[#FEE2E2] hover:text-[#DC2626]"
              title={clip.status === 'discarded' ? 'Restore clip' : 'Drop clip'}
            >
              {clip.status === 'discarded' ? 'Undo' : '×'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="studio-card max-w-xl p-8">
      <h2 className="text-2xl font-extrabold text-[#171715]">No clips came back.</h2>
      <p className="mt-3 text-sm leading-relaxed text-[#57564F]">
        The model found nothing self-contained enough to stand alone — which is a real answer for
        some source material, not necessarily a failure.
      </p>
      <p className="mt-2 text-sm leading-relaxed text-[#57564F]">
        If you expected clips, try a larger provider model, or widen the length range so shorter
        moments qualify.
      </p>
    </div>
  )
}
