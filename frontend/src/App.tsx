import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'

import { api, type SystemStatus } from './api'

/**
 * Application shell.
 *
 * A masthead rather than a sidebar: this is a four-screen tool, and a
 * persistent nav rail would spend a fifth of the width restating that.
 */
export function App() {
  const [system, setSystem] = useState<SystemStatus | null>(null)

  useEffect(() => {
    api.system().then(setSystem).catch(() => setSystem(null))
  }, [])

  return (
    <div className="min-h-screen bg-ink-900">
      <header className="sticky top-0 z-30 border-b border-ink-800/90 bg-ink-900/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1600px] items-center gap-8 px-6 py-3.5 lg:px-10">
          <NavLink to="/" className="group flex items-baseline gap-2.5">
            <span className="font-display text-2xl leading-none text-ink-100 transition-colors group-hover:text-white">
              Auto<span className="italic text-sodium-500">Clip</span>
            </span>
          </NavLink>

          <nav className="flex items-center gap-1" aria-label="Main navigation">
            <TopLink to="/" end>
              Studio
            </TopLink>
            <TopLink to="/settings">Settings</TopLink>
          </nav>

          <div className="ml-auto flex items-center gap-5">
            {system && <SystemBadge system={system} />}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-6 pb-24 lg:px-10">
        <Outlet />
      </main>
    </div>
  )
}

function TopLink({
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
          'relative px-3 py-1.5 text-sm font-medium transition-colors duration-200',
          isActive
            ? 'text-sodium-500 after:absolute after:inset-x-3 after:-bottom-[15px] after:h-[2px] after:bg-sodium-500'
            : 'text-ink-400 hover:text-ink-100',
        ].join(' ')
      }
    >
      {children}
    </NavLink>
  )
}

/**
 * Compact machine status.
 *
 * Surfaced permanently rather than hidden in settings because the two things it
 * reports — whether ffmpeg can render, and whether the GPU is being used — are
 * the two that change how long everything takes.
 */
function SystemBadge({ system }: { system: SystemStatus }) {
  const accel = system.accel.toUpperCase()
  return (
    <div className="hidden items-center gap-3 border border-ink-800 bg-ink-850/60 px-3 py-1 text-xs md:flex">
      <span className="numeric flex items-center gap-1.5 text-ink-300">
        <svg
          className="size-3.5 text-sodium-500"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          aria-hidden="true"
        >
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <rect x="9" y="9" width="6" height="6" />
          <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
        </svg>
        {accel}
        {system.gpu_name && accel === 'CUDA' && (
          <span className="text-ink-500"> · {system.gpu_name.replace('NVIDIA GeForce ', '')}</span>
        )}
      </span>
      <span className="h-3 w-px bg-ink-700" aria-hidden="true" />
      <span
        className={`flex items-center gap-1.5 ${system.ready ? 'text-ink-300' : 'text-signal-bad'}`}
        title={system.ready ? 'All required components present' : 'Run autoclip doctor'}
      >
        <span
          className={`size-1.5 rounded-full ${system.ready ? 'bg-signal-good' : 'bg-signal-bad'}`}
          aria-hidden="true"
        />
        {system.ready ? 'ready' : 'not ready'}
      </span>
    </div>
  )
}
