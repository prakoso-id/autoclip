import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'

import { api, formatBytes, type CompressResult, type Job, type SystemStatus } from './api'

/**
 * Daylight Tactile Studio shell (Concept 4).
 *
 * Persistent left sidebar with navigation, a Quick Compress dropzone always
 * within reach, and a hardware acceleration status card at the bottom.
 */
export function App() {
  const [system, setSystem] = useState<SystemStatus | null>(null)
  const [latestDoneJob, setLatestDoneJob] = useState<Job | null>(null)
  const location = useLocation()

  useEffect(() => {
    api.system().then(setSystem).catch(() => setSystem(null))
  }, [])

  useEffect(() => {
    api
      .listJobs(6)
      .then((jobs) => {
        const done = jobs.find((j) => j.status === 'done') ?? null
        setLatestDoneJob(done)
      })
      .catch(() => undefined)
  }, [location.pathname])

  return (
    <div className="min-h-screen bg-[#F4F3EE] text-[#171715] lg:grid lg:grid-cols-[240px_1fr]">
      {/* Left Sidebar */}
      <aside className="flex flex-col justify-between border-b border-[#DCD9D0] bg-[#EAE8E1] px-4 py-5 lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r">
        <div className="space-y-6">
          <NavLink to="/" className="flex items-center gap-2.5 px-2">
            <span className="grid size-7 place-items-center rounded-lg bg-[#E11D48] text-sm font-extrabold text-white shadow-xs">
              A
            </span>
            <span className="text-lg font-extrabold tracking-tight text-[#171715]">AutoClip</span>
            <span className="numeric rounded-full bg-[#DEDCD3] px-2 py-0.5 text-[10px] font-bold tracking-wider text-[#57564F]">
              STUDIO
            </span>
          </NavLink>

          <nav className="space-y-1" aria-label="Main navigation">
            <SideLink to="/" end>
              <span>＋ New Video / URL</span>
            </SideLink>

            {latestDoneJob && (
              <SideLink to={`/jobs/${latestDoneJob.id}/clips`}>
                <span className="truncate">Review Clips</span>
                <span className="numeric rounded-full bg-[#FFE4E6] px-2 py-0.5 text-[11px] font-bold text-[#E11D48]">
                  Latest
                </span>
              </SideLink>
            )}

            <SideLink to="/settings">
              <span>Settings</span>
            </SideLink>
          </nav>

          <QuickCompressWidget />
        </div>

        {system && <SystemCard system={system} />}
      </aside>

      {/* Main Workspace */}
      <main className="min-w-0 px-5 py-6 pb-20 lg:px-8">
        <div className="mx-auto max-w-[1440px]">
          <Outlet />
        </div>
      </main>
    </div>
  )
}

function SideLink({
  to,
  end,
  children,
}: {
  to: string
  end?: boolean
  children: React.ReactNode
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        [
          'flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-[13.5px] font-semibold transition-all duration-150',
          isActive
            ? 'bg-white text-[#171715] shadow-xs'
            : 'text-[#57564F] hover:bg-white/60 hover:text-[#171715]',
        ].join(' ')
      }
    >
      {children}
    </NavLink>
  )
}

function QuickCompressWidget() {
  const [dragging, setDragging] = useState(false)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [latest, setLatest] = useState<CompressResult | null>(null)
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = async (file: File) => {
    if (busyName) return
    setBusyName(file.name)
    setErrMsg(null)
    try {
      const res = await api.compressVideo(file, 23)
      setLatest(res)
    } catch (err) {
      setErrMsg((err as Error).message || 'Compress failed')
    } finally {
      setBusyName(null)
    }
  }

  return (
    <div className="rounded-2xl border border-[#E2E0D8] bg-white p-3.5 shadow-2xs">
      <div className="flex items-center justify-between">
        <span className="numeric text-[10px] font-bold uppercase tracking-wider text-[#737168]">
          Quick Compress Drop
        </span>
        <span className="numeric text-[10px] font-semibold text-[#059669]">CRF 23</span>
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
          const f = e.dataTransfer.files?.[0]
          if (f) void handleFile(f)
        }}
        onClick={() => !busyName && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !busyName) {
            e.preventDefault()
            inputRef.current?.click()
          }
        }}
        className={[
          'mt-2 cursor-pointer rounded-xl border border-dashed px-3 py-3.5 text-center text-xs transition-colors',
          dragging
            ? 'border-[#E11D48] bg-[#FFF1F2] text-[#E11D48]'
            : 'border-[#D0CEC4] bg-[#FAF9F6] text-[#57564F] hover:border-[#171715]',
        ].join(' ')}
      >
        {busyName ? (
          <span className="font-semibold text-[#171715]">Compressing {busyName}…</span>
        ) : (
          <span>Drop MP4 here to shrink ~60% (Visually Lossless)</span>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void handleFile(f)
          e.target.value = ''
        }}
      />

      {errMsg && <p className="mt-2 text-[11px] text-[#DC2626]">{errMsg}</p>}

      {latest && (
        <div className="mt-2.5 rounded-lg border border-[#D1FAE5] bg-[#ECFDF5] p-2 text-xs">
          <div className="truncate font-semibold text-[#065F46]">{latest.filename}</div>
          <div className="numeric mt-0.5 flex items-center justify-between text-[11px] text-[#047857]">
            <span>
              {formatBytes(latest.original_bytes)} → {formatBytes(latest.compressed_bytes)} (-
              {latest.saved_percent.toFixed(0)}%)
            </span>
            <a
              href={latest.download_url}
              download={latest.filename}
              className="font-bold underline"
            >
              Download
            </a>
          </div>
        </div>
      )}
    </div>
  )
}

function SystemCard({ system }: { system: SystemStatus }) {
  const accel = system.accel.toUpperCase()
  const gpuShort = system.gpu_name ? system.gpu_name.replace('NVIDIA GeForce ', '') : ''
  return (
    <div className="mt-6 rounded-xl border border-[#DEDCD3] bg-white p-3 text-xs shadow-2xs">
      <div className="flex items-center justify-between font-bold text-[#171715]">
        <span className="numeric">
          {accel}
          {gpuShort ? ` · ${gpuShort}` : ''}
        </span>
        <span
          className={`flex items-center gap-1 text-[11px] font-semibold ${
            system.ready ? 'text-[#059669]' : 'text-[#DC2626]'
          }`}
        >
          <span
            className={`size-1.5 rounded-full ${system.ready ? 'bg-[#059669]' : 'bg-[#DC2626]'}`}
          />
          {system.ready ? 'Ready' : 'Check doctor'}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-[#737168]">
        {system.nvenc_works ? 'NVENC GPU Encoding' : 'CPU Encoding'} ·{' '}
        {system.diarization_available ? 'LR-ASD + Diarization' : 'LR-ASD Active Speaker'}
      </div>
    </div>
  )
}
