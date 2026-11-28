import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { api, formatDuration } from '../api'
import { ErrorNote } from '../components/ErrorNote'
import { useJobStream } from '../useJobStream'

/** Stage order and labels, mirroring autoclip.pipeline.Stage. */
const STAGES = [
  { key: 'prepare', label: 'Prepare', note: 'Extracting audio and thumbnails' },
  { key: 'transcribe', label: 'Transcribe', note: 'Word-level timing' },
  { key: 'highlights', label: 'Highlights', note: 'Choosing the moments worth cutting' },
  { key: 'reframe', label: 'Reframe', note: 'Tracking the speaker into vertical' },
  { key: 'captions', label: 'Captions', note: 'Building subtitle timing' },
  { key: 'export', label: 'Export', note: 'Rendering clips' },
] as const

export function JobProgress() {
  const { jobId } = useParams()
  const navigate = useNavigate()
  const { job, progress } = useJobStream(jobId)
  const [cancelling, setCancelling] = useState(false)
  const [actionError, setActionError] = useState<Error | null>(null)

  useEffect(() => {
    if (job?.status === 'done') {
      // A short hold so the completed state is legible rather than a flash.
      const timer = setTimeout(() => navigate(`/jobs/${job.id}/clips`), 900)
      return () => clearTimeout(timer)
    }
  }, [job?.status, job?.id, navigate])

  if (!job) {
    return <p className="pt-24 text-sm text-ink-500">Loading…</p>
  }

  const activeIndex = STAGES.findIndex((s) => s.key === job.current_stage)
  const percent = Math.round((progress?.overall ?? job.progress) * 100)

  const cancel = async () => {
    setCancelling(true)
    setActionError(null)
    try {
      await api.cancelJob(job.id)
    } catch (err) {
      setActionError(err as Error)
    } finally {
      setCancelling(false)
    }
  }

  const retry = async () => {
    setActionError(null)
    try {
      await api.retryJob(job.id)
      window.location.reload()
    } catch (err) {
      setActionError(err as Error)
    }
  }

  return (
    <div className="space-y-6">
      <div className="studio-card rise flex flex-wrap items-center justify-between gap-6 px-6 py-5">
        <div className="min-w-0">
          <p className="eyebrow">{job.status}</p>
          <h1 className="mt-1 max-w-3xl truncate text-2xl font-extrabold tracking-tight text-ink-100">
            {job.source?.title || 'Untitled'}
          </h1>
          {job.source && (
            <p className="numeric mt-1 text-xs font-medium text-ink-500">
              {formatDuration(job.source.duration_s)}
              {job.source.width ? ` · ${job.source.width}×${job.source.height}` : ''} ·{' '}
              {job.provider}
            </p>
          )}
        </div>

        <div className="flex items-center gap-6">
          <span className="numeric text-4xl font-extrabold leading-none text-sodium-500">
            {percent}
            <span className="text-xl text-ink-500">%</span>
          </span>
          {(job.status === 'running' || job.status === 'queued') && (
            <button onClick={cancel} disabled={cancelling} className="btn btn-ghost">
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          {(job.status === 'failed' || job.status === 'cancelled') && (
            <button onClick={retry} className="btn btn-primary">
              Retry Job
            </button>
          )}
          {job.status === 'done' && (
            <button onClick={() => navigate(`/jobs/${job.id}/clips`)} className="btn btn-primary">
              Review Clips →
            </button>
          )}
        </div>
      </div>

      {job.error && (
        <div className="studio-card max-w-3xl p-5">
          <ErrorNote error={new Error(job.error)} />
          <p className="mt-3 text-xs text-ink-500">
            Retrying resumes from the stage that failed — finished stages are not redone.
          </p>
        </div>
      )}

      {actionError && (
        <div className="studio-card max-w-3xl p-5">
          <ErrorNote error={actionError} onDismiss={() => setActionError(null)} />
        </div>
      )}

      <ol className="studio-card max-w-3xl divide-y divide-ink-800 px-6 py-2">
        {STAGES.map((stage, index) => {
          // A failed job stopped *at* current_stage, so that stage must read as
          // failed rather than as still running — otherwise the checklist claims
          // work is in progress while the banner says it died.
          const failedHere =
            (job.status === 'failed' || job.status === 'cancelled') && index === activeIndex

          const state =
            job.status === 'done' || (activeIndex >= 0 && index < activeIndex)
              ? 'done'
              : failedHere
                ? 'stopped'
                : index === activeIndex && job.status === 'running'
                  ? 'active'
                  : 'pending'

          const fraction =
            state === 'done' ? 1 : state === 'active' ? (progress?.stageProgress ?? 0) : 0

          return (
            <li
              key={stage.key}
              className="rise grid grid-cols-[2.5rem_1fr] items-start gap-x-5 border-b border-ink-850 py-5"
              style={{ animationDelay: `${index * 55}ms` }}
            >
              <span
                className={[
                  'numeric pt-0.5 text-xs',
                  state === 'done'
                    ? 'text-signal-good'
                    : state === 'stopped'
                      ? 'text-signal-bad'
                      : state === 'active'
                        ? 'text-sodium-500'
                        : 'text-ink-600',
                ].join(' ')}
              >
                {state === 'done' ? '✓' : state === 'stopped' ? '✕' : String(index + 1).padStart(2, '0')}
              </span>

              <div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                  <span
                    className={[
                      'text-[0.9375rem]',
                      state === 'pending' ? 'text-ink-600' : 'text-ink-100',
                    ].join(' ')}
                  >
                    {stage.label}
                  </span>
                  <span
                    className={`text-xs ${state === 'stopped' ? 'text-signal-bad' : 'text-ink-500'}`}
                  >
                    {state === 'stopped'
                      ? job.status === 'cancelled'
                        ? 'cancelled here'
                        : 'failed here'
                      : state === 'active'
                        ? (progress?.message ?? stage.note)
                        : stage.note}
                  </span>
                </div>

                {/* A hairline that fills. No track chrome — the rule below the
                    row already provides the container. */}
                <div className="mt-3 h-px w-full bg-ink-800">
                  <div
                    className="h-px origin-left bg-sodium-500 transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
                    style={{ transform: `scaleX(${fraction})` }}
                  />
                </div>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
