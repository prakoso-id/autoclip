import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import {
  ApiError,
  api,
  formatBytes,
  formatDuration,
  type CompressResult,
  type Job,
  type JobSettingsOverrides,
  type ProviderStatus,
} from '../api'
import { ErrorNote } from '../components/ErrorNote'

export function Ingest() {
  const navigate = useNavigate()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<'url' | 'file' | null>(null)
  const [error, setError] = useState<ApiError | Error | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [overrides, setOverrides] = useState<JobSettingsOverrides>({})
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.listJobs(8).then(setJobs).catch(() => undefined)
    api.providerStatus().then(setProviders).catch(() => undefined)
    api
      .getSettings()
      .then((s) => {
        const defaultPrompt = s.whisper.initial_prompt?.trim()
        if (defaultPrompt) {
          setOverrides((prev) =>
            prev.initial_prompt === undefined ? { ...prev, initial_prompt: defaultPrompt } : prev,
          )
        }
      })
      .catch(() => undefined)
  }, [])

  const start = useCallback(
    async (kind: 'url' | 'file', run: () => Promise<{ id: string }>) => {
      setBusy(kind)
      setError(null)
      try {
        const source = await run()
        const job = await api.createJob(source.id, overrides)
        navigate(`/jobs/${job.id}`)
      } catch (err) {
        setError(err as Error)
      } finally {
        setBusy(null)
      }
    },
    [navigate, overrides],
  )

  const submitUrl = (event: React.FormEvent) => {
    event.preventDefault()
    if (!url.trim()) return
    void start('url', () => api.ingestYouTube(url.trim()))
  }

  const submitFile = (file: File) => void start('file', () => api.uploadSource(file))

  const usableProvider = providers.find((p) => p.available)

  return (
    <div className="pt-14">
      {/* Masthead. Left-aligned and asymmetric — the field is the subject, not
          a centred hero card. */}
      <div className="rise max-w-3xl">
        <p className="eyebrow">Local · No accounts · No watermarks</p>
        <h1 className="mt-5 font-display text-[clamp(2.75rem,7vw,5.5rem)] leading-[0.95] text-ink-100">
          Long video in.
          <br />
          <span className="italic text-sodium-500">Shorts</span> out.
        </h1>
      </div>

      <div className="mt-16 grid gap-x-16 gap-y-12 lg:grid-cols-[1.35fr_1fr]">
        {/* URL */}
        <section className="rise" style={{ animationDelay: '90ms' }}>
          <form onSubmit={submitUrl}>
            <label htmlFor="url" className="eyebrow">
              Paste a link
            </label>
            <div className="mt-3 flex items-end gap-4">
              <input
                id="url"
                className="field font-display text-xl md:text-2xl"
                placeholder="https://youtube.com/watch?v=…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={busy !== null}
              />
              <button
                type="submit"
                className="btn btn-primary shrink-0"
                disabled={busy !== null || !url.trim()}
              >
                {busy === 'url' ? (
                  'Fetching…'
                ) : (
                  <>
                    <span>Start</span>
                    <svg
                      className="size-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      aria-hidden="true"
                    >
                      <path d="M5 12h14M13 5l7 7-7 7" />
                    </svg>
                  </>
                )}
              </button>
            </div>
          </form>

          <p className="mt-3 text-xs leading-relaxed text-ink-500">
            Only download video you own or have the rights to process.
          </p>

          <div className="mt-7">
            <label htmlFor="transcription-context" className="eyebrow">
              Transcription context / keywords (optional)
            </label>
            <input
              id="transcription-context"
              className="field mt-2 text-sm"
              placeholder="Contoh: Podcast Obrolan Tiba-tiba bahas anime Giant Killing, Dead End Job, Webtoon…"
              value={overrides.initial_prompt ?? ''}
              onChange={(e) =>
                setOverrides((prev) => ({ ...prev, initial_prompt: e.target.value }))
              }
              disabled={busy !== null}
            />
            <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
              Berlaku untuk link YouTube maupun upload file — bantu Whisper mengeja nama, judul, dan
              istilah asing dengan akurat.
            </p>
          </div>

          <AdvancedOptions
            open={advancedOpen}
            onToggle={() => setAdvancedOpen((v) => !v)}
            overrides={overrides}
            onChange={setOverrides}
            providers={providers}
          />
        </section>

        {/* Upload */}
        <section className="rise" style={{ animationDelay: '160ms' }}>
          <p className="eyebrow">Or drop a file</p>
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              const file = e.dataTransfer.files[0]
              if (file) submitFile(file)
            }}
            className={[
              'group mt-3 flex min-h-56 cursor-pointer flex-col items-center justify-center gap-2.5 border border-dashed px-6 text-center transition-all duration-200',
              dragging
                ? 'border-sodium-500 bg-sodium-700/15'
                : 'border-ink-700 bg-ink-850/35 hover:border-ink-500 hover:bg-ink-850/70',
            ].join(' ')}
            onClick={() => fileInput.current?.click()}
            role="button"
            tabIndex={0}
            aria-label="Upload local video or audio file"
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                fileInput.current?.click()
              }
            }}
          >
            <span className="grid size-10 place-items-center rounded-full border border-ink-700 bg-ink-900/80 text-ink-300 transition-colors group-hover:border-sodium-500/60 group-hover:text-sodium-500">
              <svg
                className="size-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                aria-hidden="true"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </span>
            <span className="font-display text-2xl text-ink-100">
              {busy === 'file' ? 'Uploading…' : 'Drop video or audio'}
            </span>
            <span className="text-xs text-ink-500">mp4 · mov · mkv · webm · mp3 · wav · m4a</span>
          </div>
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            accept="video/*,audio/*"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) submitFile(file)
              e.target.value = ''
            }}
          />
        </section>
      </div>

      {error && (
        <div className="mt-10 max-w-3xl">
          <ErrorNote error={error} onDismiss={() => setError(null)} />
        </div>
      )}

      {providers.length > 0 && !usableProvider && (
        <p className="mt-10 max-w-3xl border-l-2 border-sodium-600 pl-4 text-sm text-ink-300">
          No AI provider is reachable yet, so clip selection will fail. Add an API key or
          start Ollama in{' '}
          <a href="/settings" className="text-sodium-500 underline underline-offset-4">
            Settings
          </a>
          .
        </p>
      )}

      <CompressTool />

      <RecentJobs jobs={jobs} />
    </div>
  )
}

function CompressTool() {
  const [crf, setCrf] = useState<number>(23)
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState<{ current: number; total: number; name: string } | null>(
    null,
  )
  const [results, setResults] = useState<CompressResult[]>([])
  const [error, setError] = useState<ApiError | Error | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList)
    if (files.length === 0 || progress !== null) return
    setError(null)
    try {
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i]
        setProgress({ current: i + 1, total: files.length, name: file.name })
        const res = await api.compressVideo(file, crf)
        setResults((prev) => [res, ...prev])
      }
    } catch (err) {
      setError(err as Error)
    } finally {
      setProgress(null)
    }
  }

  return (
    <section className="rise mt-20" style={{ animationDelay: '200ms' }}>
      <div className="flex flex-wrap items-baseline justify-between gap-4 border-b border-ink-800 pb-3">
        <div>
          <h2 className="eyebrow">Compress video · H.264 Visually Lossless</h2>
          <p className="mt-1 text-xs text-ink-500">
            Perkecil ukuran video 50–65% tanpa penurunan kualitas yang terlihat — cocok untuk
            TikTok, Reels, Shorts, & WhatsApp.
          </p>
        </div>

        <label className="flex items-center gap-2 text-xs text-ink-400">
          <span>Mode:</span>
          <select
            value={crf}
            disabled={progress !== null}
            onChange={(e) => setCrf(Number(e.target.value))}
            className="field w-auto cursor-pointer py-1 text-xs"
          >
            <option value={23} className="bg-ink-850">
              Visually lossless (CRF 23)
            </option>
            <option value={26} className="bg-ink-850">
              Extra compact (CRF 26)
            </option>
          </select>
        </label>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          if (e.dataTransfer.files.length > 0) void handleFiles(e.dataTransfer.files)
        }}
        onClick={() => progress === null && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && progress === null) {
            inputRef.current?.click()
          }
        }}
        className={[
          'group mt-4 flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 border border-dashed px-6 py-5 text-center transition-all duration-200',
          dragging
            ? 'border-sodium-500 bg-sodium-700/15'
            : 'border-ink-700 bg-ink-850/35 hover:border-ink-500 hover:bg-ink-850/70',
        ].join(' ')}
      >
        <span className="flex items-center gap-2 font-display text-xl text-ink-100">
          <svg
            className="size-4 text-sodium-500"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            aria-hidden="true"
          >
            <polyline points="4 14 10 14 10 20" />
            <polyline points="20 10 14 10 14 4" />
            <line x1="14" y1="10" x2="21" y2="3" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
          {progress
            ? `Compressing ${progress.current}/${progress.total} · ${progress.name}…`
            : 'Drop video(s) to compress'}
        </span>
        <span className="text-xs text-ink-500">
          Bisa pilih 1 atau banyak file sekaligus · mp4 · mov · mkv · webm
        </span>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) void handleFiles(e.target.files)
          e.target.value = ''
        }}
      />

      {error && (
        <div className="mt-4 max-w-3xl">
          <ErrorNote error={error} onDismiss={() => setError(null)} />
        </div>
      )}

      {results.length > 0 && (
        <div className="mt-4">
          <div className="flex items-center justify-between pb-2">
            <span className="numeric text-xs text-ink-400">
              {results.length} compressed file{results.length > 1 ? 's' : ''} ready
            </span>
            <button
              type="button"
              onClick={() => setResults([])}
              className="btn btn-quiet text-xs"
            >
              Clear list
            </button>
          </div>
          <ul className="divide-y divide-ink-800 border-y border-ink-800 bg-ink-850/30">
            {results.map((item) => {
              const ratio =
                item.original_bytes > 0
                  ? Math.min(100, Math.round((item.compressed_bytes / item.original_bytes) * 100))
                  : 100
              return (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-ink-100">{item.filename}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-3">
                      <span className="numeric text-xs text-ink-400">
                        {formatBytes(item.original_bytes)} →{' '}
                        <strong className="text-ink-100">
                          {formatBytes(item.compressed_bytes)}
                        </strong>
                      </span>
                      <span className="numeric inline-flex items-center border border-signal-good/40 bg-signal-good/10 px-1.5 py-0.5 text-[11px] font-semibold text-signal-good">
                        -{item.saved_percent.toFixed(0)}% saved
                      </span>
                      <div
                        className="hidden h-1 w-24 overflow-hidden bg-ink-800 sm:block"
                        title={`Compressed to ${ratio}% of original size`}
                      >
                        <div
                          className="h-full bg-signal-good"
                          style={{ width: `${ratio}%` }}
                        />
                      </div>
                    </div>
                  </div>
                  <a
                    href={item.download_url}
                    download={item.filename}
                    className="btn btn-primary"
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
                    <span>Download</span>
                  </a>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}

function AdvancedOptions({
  open,
  onToggle,
  overrides,
  onChange,
  providers,
}: {
  open: boolean
  onToggle: () => void
  overrides: JobSettingsOverrides
  onChange: (next: JobSettingsOverrides) => void
  providers: ProviderStatus[]
}) {
  const set = <K extends keyof JobSettingsOverrides>(key: K, value: JobSettingsOverrides[K]) =>
    onChange({ ...overrides, [key]: value })

  return (
    <div className="mt-8">
      <button type="button" onClick={onToggle} className="btn btn-quiet -ml-1">
        <span
          className="inline-block transition-transform duration-300"
          style={{ transform: open ? 'rotate(90deg)' : 'none' }}
          aria-hidden
        >
          ›
        </span>
        {open ? 'Hide options' : 'Options'}
      </button>

      {/* grid-template-rows rather than height, so the reveal animates without
          touching layout properties. */}
      <div
        className="grid transition-[grid-template-rows] duration-400 ease-[cubic-bezier(0.16,1,0.3,1)]"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div className="grid gap-x-8 gap-y-5 pt-5 sm:grid-cols-2">
            <Selector
              label="Provider"
              value={overrides.provider ?? ''}
              onChange={(v) => set('provider', v || undefined)}
              options={[
                { value: '', label: 'Use default' },
                ...providers.map((p) => ({
                  value: p.name,
                  label: p.available ? p.name : `${p.name} — unavailable`,
                  disabled: !p.available,
                })),
              ]}
            />
            <Selector
              label="Whisper model"
              value={overrides.whisper_model ?? ''}
              onChange={(v) => set('whisper_model', v || undefined)}
              options={[
                { value: '', label: 'Use default' },
                { value: 'tiny', label: 'tiny — fastest, roughest' },
                { value: 'base', label: 'base' },
                { value: 'small', label: 'small — balanced' },
                { value: 'medium', label: 'medium' },
                { value: 'large-v3', label: 'large-v3 — slowest, best' },
              ]}
            />
            <NumberField
              label="Max clips"
              value={overrides.max_clips}
              placeholder="10"
              min={1}
              max={50}
              onChange={(v) => set('max_clips', v)}
            />
            <div className="grid grid-cols-2 gap-4">
              <NumberField
                label="Min length (s)"
                value={overrides.min_duration_s}
                placeholder="20"
                min={5}
                max={300}
                onChange={(v) => set('min_duration_s', v)}
              />
              <NumberField
                label="Max length (s)"
                value={overrides.max_duration_s}
                placeholder="90"
                min={5}
                max={300}
                onChange={(v) => set('max_duration_s', v)}
              />
            </div>
            <label className="flex items-center gap-3 text-sm text-ink-200 sm:col-span-2">
              <input
                type="checkbox"
                checked={overrides.diarization ?? false}
                onChange={(e) => set('diarization', e.target.checked || undefined)}
                className="size-4 accent-sodium-500"
              />
              Multiple speakers — label who is talking, and cut to them
            </label>
          </div>
        </div>
      </div>
    </div>
  )
}

function Selector({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string; disabled?: boolean }[]
}) {
  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="field mt-1 cursor-pointer text-sm"
      >
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            className="bg-ink-850"
          >
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function NumberField({
  label,
  value,
  placeholder,
  min,
  max,
  onChange,
}: {
  label: string
  value: number | undefined
  placeholder: string
  min: number
  max: number
  onChange: (value: number | undefined) => void
}) {
  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      <input
        type="number"
        className="field numeric mt-1 text-sm"
        placeholder={placeholder}
        value={value ?? ''}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
      />
    </label>
  )
}

function RecentJobs({ jobs }: { jobs: Job[] }) {
  const [filter, setFilter] = useState<'all' | 'done' | 'failed'>('all')
  if (jobs.length === 0) return null

  const filtered = jobs.filter((j) => (filter === 'all' ? true : j.status === filter))

  return (
    <section className="rise mt-24" style={{ animationDelay: '240ms' }}>
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-ink-800 pb-3">
        <div className="flex items-baseline gap-3">
          <h2 className="eyebrow">Recent sessions</h2>
          <span className="numeric text-xs text-ink-500">{jobs.length}</span>
        </div>

        {jobs.length > 2 && (
          <div className="flex items-center gap-1 text-xs">
            {(['all', 'done', 'failed'] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={[
                  'cursor-pointer px-2.5 py-1 capitalize transition-colors',
                  filter === key
                    ? 'bg-ink-800 text-ink-100'
                    : 'text-ink-400 hover:text-ink-200',
                ].join(' ')}
              >
                {key}
              </button>
            ))}
          </div>
        )}
      </div>

      <ul>
        {filtered.map((job) => (
          <li key={job.id}>
            <a
              href={job.status === 'done' ? `/jobs/${job.id}/clips` : `/jobs/${job.id}`}
              className="group grid grid-cols-[1fr_auto] items-center gap-4 border-b border-ink-850 px-2 py-4 transition-colors duration-200 hover:bg-ink-850/55 sm:grid-cols-[1fr_7rem_6rem_7.5rem]"
            >
              <div className="min-w-0">
                <span className="block truncate text-[0.9375rem] font-medium text-ink-200 transition-colors group-hover:text-ink-100">
                  {job.source?.title || 'Untitled'}
                </span>
                {job.error && job.status === 'failed' && (
                  <span className="mt-0.5 block truncate text-xs text-signal-bad/90">
                    {job.error}
                  </span>
                )}
              </div>
              <span className="numeric hidden text-xs text-ink-400 sm:block">
                {job.source ? formatDuration(job.source.duration_s) : '—'}
              </span>
              <span className="hidden text-xs text-ink-400 sm:block">{job.provider}</span>
              <StatusTag job={job} />
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

function StatusTag({ job }: { job: Job }) {
  const tone: Record<string, string> = {
    done: 'text-signal-good',
    failed: 'text-signal-bad',
    running: 'text-sodium-500',
    queued: 'text-ink-400',
    cancelled: 'text-ink-500',
  }
  const dot: Record<string, string> = {
    done: 'bg-signal-good',
    failed: 'bg-signal-bad',
    running: 'bg-sodium-500 animate-pulse',
    queued: 'bg-ink-400',
    cancelled: 'bg-ink-500',
  }
  const label =
    job.status === 'running'
      ? `${Math.round(job.progress * 100)}%`
      : job.status === 'done'
        ? 'Review →'
        : job.status

  return (
    <span
      className={`numeric inline-flex items-center justify-self-end gap-1.5 text-xs font-medium ${tone[job.status] ?? 'text-ink-400'}`}
    >
      <span className={`size-1.5 rounded-full ${dot[job.status] ?? 'bg-ink-500'}`} aria-hidden />
      {label}
    </span>
  )
}
