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
  const [activeTab, setActiveTab] = useState<'clips' | 'compress'>('clips')
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
    api.listJobs(10).then(setJobs).catch(() => undefined)
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
    <div className="space-y-6">
      {/* Top Studio Header Bar */}
      <div className="studio-card flex flex-wrap items-center justify-between gap-4 px-6 py-4">
        <div>
          <span className="numeric text-xs font-bold uppercase tracking-wider text-[#E11D48]">
            AutoClip Daylight Studio · Local AI Pipeline
          </span>
          <h1 className="mt-0.5 text-2xl font-extrabold tracking-tight text-[#171715]">
            Long video in. Vertical Shorts out.
          </h1>
        </div>

        {/* Clean Segmented Mode Switcher */}
        <div className="inline-flex rounded-xl border border-[#DCD9D0] bg-[#EAE8E1] p-1">
          <button
            type="button"
            onClick={() => setActiveTab('clips')}
            className={[
              'cursor-pointer rounded-lg px-4 py-1.5 text-xs font-bold transition-all',
              activeTab === 'clips'
                ? 'bg-white text-[#171715] shadow-2xs'
                : 'text-[#57564F] hover:text-[#171715]',
            ].join(' ')}
          >
            Create Clips
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('compress')}
            className={[
              'cursor-pointer rounded-lg px-4 py-1.5 text-xs font-bold transition-all',
              activeTab === 'compress'
                ? 'bg-white text-[#171715] shadow-2xs'
                : 'text-[#57564F] hover:text-[#171715]',
            ].join(' ')}
          >
            H.264 Compressor
          </button>
        </div>
      </div>

      {error && <ErrorNote error={error} onDismiss={() => setError(null)} />}

      {providers.length > 0 && !usableProvider && (
        <div className="studio-card border-[#FDE68A] bg-[#FFFBEB] px-5 py-3.5 text-sm text-[#92400E]">
          No AI provider is reachable yet, so clip selection will fail. Add an API key or start
          Ollama in{' '}
          <a href="/settings" className="font-bold text-[#E11D48] underline">
            Settings
          </a>
          .
        </div>
      )}

      {activeTab === 'clips' ? (
        <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
          {/* Left Card: YouTube URL + Transcription Context */}
          <section className="studio-card flex flex-col justify-between p-6">
            <div className="space-y-5">
              <form onSubmit={submitUrl}>
                <label htmlFor="url" className="eyebrow">
                  Paste YouTube Link
                </label>
                <div className="mt-2 flex gap-2.5">
                  <input
                    id="url"
                    className="field text-base font-medium"
                    placeholder="https://youtube.com/watch?v=…"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy !== null}
                  />
                  <button
                    type="submit"
                    className="btn btn-primary shrink-0 px-5"
                    disabled={busy !== null || !url.trim()}
                  >
                    {busy === 'url' ? 'Fetching…' : 'Start Job'}
                  </button>
                </div>
              </form>

              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="transcription-context" className="eyebrow">
                    Transcription Context / Keywords (Optional)
                  </label>
                  <span className="numeric text-[11px] font-semibold text-[#737168]">
                    Whisper Initial Prompt
                  </span>
                </div>
                <input
                  id="transcription-context"
                  className="field mt-1.5 text-sm"
                  placeholder="Contoh: Podcast Obrolan Tiba-tiba bahas anime Giant Killing, Dead End Job, Webtoon…"
                  value={overrides.initial_prompt ?? ''}
                  onChange={(e) =>
                    setOverrides((prev) => ({ ...prev, initial_prompt: e.target.value }))
                  }
                  disabled={busy !== null}
                />
                <p className="mt-1.5 text-xs text-[#737168]">
                  Applies to both YouTube URLs and local uploads — guides Whisper on host names,
                  titles, and Indonesian/English terms.
                </p>
              </div>
            </div>

            <AdvancedOptions
              open={advancedOpen}
              onToggle={() => setAdvancedOpen((v) => !v)}
              overrides={overrides}
              onChange={setOverrides}
              providers={providers}
            />
          </section>

          {/* Right Card: Local Video / Audio Dropzone */}
          <section className="studio-card flex flex-col justify-between p-6">
            <div>
              <span className="eyebrow">Or Upload Local Media</span>
              <p className="mt-1 text-xs text-[#737168]">
                Process a local podcast recording directly without uploading to the cloud.
              </p>
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
                const file = e.dataTransfer.files[0]
                if (file) submitFile(file)
              }}
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
              className={[
                'mt-4 flex min-h-52 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 text-center transition-all',
                dragging
                  ? 'border-[#E11D48] bg-[#FFF1F2]'
                  : 'border-[#D2CFC6] bg-[#FAF9F6] hover:border-[#171715] hover:bg-white',
              ].join(' ')}
            >
              <span className="text-lg font-extrabold text-[#171715]">
                {busy === 'file' ? 'Uploading…' : 'Drop video or audio file here'}
              </span>
              <span className="numeric text-xs font-medium text-[#737168]">
                MP4 · MOV · MKV · WEBM · MP3 · WAV · M4A
              </span>
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
      ) : (
        <CompressTool />
      )}

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
    <section className="studio-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <span className="eyebrow">H.264 Visually Lossless Compressor</span>
          <p className="mt-1 text-xs text-[#737168]">
            Shrink video file size by 50–65% with no visible quality loss — 100% compatible with
            TikTok, Reels, Shorts, and WhatsApp.
          </p>
        </div>

        <label className="flex items-center gap-2 text-xs font-semibold text-[#57564F]">
          <span>Preset:</span>
          <select
            value={crf}
            disabled={progress !== null}
            onChange={(e) => setCrf(Number(e.target.value))}
            className="field w-auto cursor-pointer py-1.5 text-xs font-bold"
          >
            <option value={23}>Visually Lossless · Social (CRF 23)</option>
            <option value={26}>Extra Compact · Smallest (CRF 26)</option>
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
            e.preventDefault()
            inputRef.current?.click()
          }
        }}
        className={[
          'mt-4 flex min-h-40 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed px-6 py-6 text-center transition-all',
          dragging
            ? 'border-[#E11D48] bg-[#FFF1F2]'
            : 'border-[#D2CFC6] bg-[#FAF9F6] hover:border-[#171715] hover:bg-white',
        ].join(' ')}
      >
        <span className="text-lg font-extrabold text-[#171715]">
          {progress
            ? `Compressing ${progress.current}/${progress.total} · ${progress.name}…`
            : 'Drop 1 or multiple videos here to compress'}
        </span>
        <span className="numeric text-xs font-medium text-[#737168]">
          Batch supported · MP4 · MOV · MKV · WEBM
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
        <div className="mt-4">
          <ErrorNote error={error} onDismiss={() => setError(null)} />
        </div>
      )}

      {results.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between">
            <span className="numeric text-xs font-bold text-[#57564F]">
              {results.length} Compressed File{results.length > 1 ? 's' : ''}
            </span>
            <button
              type="button"
              onClick={() => setResults([])}
              className="btn btn-quiet text-xs"
            >
              Clear list
            </button>
          </div>
          <ul className="divide-y divide-[#EAE8E1] rounded-xl border border-[#E2E0D8] bg-[#FAF9F6]">
            {results.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-bold text-[#171715]">{item.filename}</p>
                  <p className="numeric mt-0.5 text-xs text-[#57564F]">
                    {formatBytes(item.original_bytes)} →{' '}
                    <strong className="text-[#171715]">{formatBytes(item.compressed_bytes)}</strong>
                    <span className="ml-2 rounded-md bg-[#D1FAE5] px-1.5 py-0.5 text-[11px] font-bold text-[#065F46]">
                      -{item.saved_percent.toFixed(0)}% saved
                    </span>
                  </p>
                </div>
                <a href={item.download_url} download={item.filename} className="btn btn-dark">
                  ⬇ Download MP4
                </a>
              </li>
            ))}
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
    <div className="mt-5 border-t border-[#EAE8E1] pt-4">
      <button type="button" onClick={onToggle} className="btn btn-quiet -ml-2 text-xs font-bold">
        <span>{open ? '▾ Hide Job Overrides' : '▸ Job Overrides (Model, Clip Count, Length)'}</span>
      </button>

      {open && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
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
              { value: 'tiny', label: 'tiny — fastest' },
              { value: 'base', label: 'base' },
              { value: 'small', label: 'small — balanced' },
              { value: 'medium', label: 'medium' },
              { value: 'large-v3', label: 'large-v3 — most accurate' },
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
          <div className="grid grid-cols-2 gap-3">
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
          <label className="flex cursor-pointer items-center gap-2.5 text-xs font-semibold text-[#3D3C37] sm:col-span-2">
            <input
              type="checkbox"
              checked={overrides.diarization ?? false}
              onChange={(e) => set('diarization', e.target.checked || undefined)}
              className="size-4 accent-[#E11D48]"
            />
            Multiple speakers — identify hosts and color-code captions
          </label>
        </div>
      )}
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
        className="field mt-1 cursor-pointer text-xs font-semibold"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
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
        min={min}
        max={max}
        placeholder={placeholder}
        value={value ?? ''}
        onChange={(e) => {
          const parsed = Number(e.target.value)
          onChange(e.target.value === '' || Number.isNaN(parsed) ? undefined : parsed)
        }}
        className="numeric field mt-1 text-xs font-semibold"
      />
    </label>
  )
}

function RecentJobs({ jobs }: { jobs: Job[] }) {
  const [filter, setFilter] = useState<'all' | 'done' | 'failed'>('all')
  if (jobs.length === 0) return null

  const filtered = jobs.filter((j) => (filter === 'all' ? true : j.status === filter))

  return (
    <section className="studio-card p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <h2 className="text-sm font-extrabold text-[#171715]">Recent Sessions</h2>
          <span className="numeric rounded-full bg-[#EAE8E1] px-2 py-0.5 text-xs font-bold text-[#57564F]">
            {jobs.length}
          </span>
        </div>

        {jobs.length > 2 && (
          <div className="inline-flex rounded-lg border border-[#E2E0D8] bg-[#FAF9F6] p-0.5 text-xs">
            {(['all', 'done', 'failed'] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={[
                  'cursor-pointer rounded-md px-2.5 py-1 font-bold capitalize transition-colors',
                  filter === key
                    ? 'bg-[#171715] text-white'
                    : 'text-[#57564F] hover:text-[#171715]',
                ].join(' ')}
              >
                {key}
              </button>
            ))}
          </div>
        )}
      </div>

      <ul className="divide-y divide-[#EAE8E1] rounded-xl border border-[#EAE8E1] bg-[#FAF9F6]">
        {filtered.map((job) => (
          <li key={job.id}>
            <a
              href={job.status === 'done' ? `/jobs/${job.id}/clips` : `/jobs/${job.id}`}
              className="group grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-3.5 transition-colors hover:bg-white sm:grid-cols-[1fr_6.5rem_6rem_7.5rem]"
            >
              <div className="min-w-0">
                <span className="block truncate text-sm font-bold text-[#171715] group-hover:text-[#E11D48]">
                  {job.source?.title || 'Untitled'}
                </span>
                {job.error && job.status === 'failed' && (
                  <span className="mt-0.5 block truncate text-xs text-[#DC2626]">{job.error}</span>
                )}
              </div>
              <span className="numeric hidden text-xs font-medium text-[#737168] sm:block">
                {job.source ? formatDuration(job.source.duration_s) : '—'}
              </span>
              <span className="numeric hidden text-xs font-medium text-[#737168] sm:block">
                {job.provider}
              </span>
              <StatusBadge job={job} />
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

function StatusBadge({ job }: { job: Job }) {
  const styles: Record<string, string> = {
    done: 'bg-[#D1FAE5] text-[#065F46]',
    failed: 'bg-[#FEE2E2] text-[#991B1B]',
    running: 'bg-[#FFE4E6] text-[#E11D48]',
    queued: 'bg-[#EAE8E1] text-[#57564F]',
    cancelled: 'bg-[#EAE8E1] text-[#737168]',
  }
  const label =
    job.status === 'running'
      ? `${Math.round(job.progress * 100)}%`
      : job.status === 'done'
        ? 'Review Clips →'
        : job.status

  return (
    <span
      className={`numeric inline-flex items-center justify-self-end rounded-lg px-2.5 py-1 text-xs font-bold ${
        styles[job.status] ?? 'bg-[#EAE8E1] text-[#57564F]'
      }`}
    >
      {label}
    </span>
  )
}
