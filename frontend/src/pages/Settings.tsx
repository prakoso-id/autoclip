import { useEffect, useState } from 'react'

import {
  api,
  type IntroSettings,
  type OutroSettings,
  type ProviderStatus,
  type Settings as SettingsData,
  type SystemStatus,
} from '../api'
import { ErrorNote } from '../components/ErrorNote'

const PREVIEW_RATIOS = ['9:16', '1:1', '16:9'] as const

const SECRET_LABELS: Record<string, string> = {
  anthropic: 'Anthropic API key',
  openai: 'OpenAI-compatible API key',
  gemini: 'Google Gemini API key',
  huggingface_token: 'HuggingFace token',
}

export function Settings() {
  const [settings, setSettings] = useState<SettingsData | null>(null)
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [system, setSystem] = useState<SystemStatus | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [saved, setSaved] = useState(false)
  const [previewRatio, setPreviewRatio] = useState<string>('9:16')
  const [previewVersion, setPreviewVersion] = useState(0)

  const reload = () => {
    void api.getSettings().then(setSettings).catch((e) => setError(e as Error))
    void api.providerStatus().then(setProviders).catch(() => undefined)
    void api.system().then(setSystem).catch(() => undefined)
  }

  useEffect(reload, [])

  const patch = async (update: Partial<SettingsData>) => {
    setError(null)
    try {
      setSettings(await api.putSettings(update))
      setPreviewVersion((v) => v + 1)
      setSaved(true)
      setTimeout(() => setSaved(false), 1600)
    } catch (err) {
      setError(err as Error)
    }
  }

  const patchOutro = (outroPatch: Partial<OutroSettings>) => {
    if (!settings) return
    return patch({
      export: {
        ...settings.export,
        outro: { ...settings.export.outro, ...outroPatch },
      },
    })
  }

  const patchIntro = (introPatch: Partial<IntroSettings>) => {
    if (!settings) return
    return patch({
      export: {
        ...settings.export,
        intro: { ...settings.export.intro, ...introPatch },
      },
    })
  }

  if (!settings) return <p className="pt-24 text-sm text-ink-500">Loading…</p>

  return (
    <div className="max-w-4xl space-y-5">
      <div className="studio-card rise flex items-center justify-between px-6 py-4">
        <div>
          <span className="numeric text-xs font-bold uppercase tracking-wider text-sodium-500">
            Studio Configuration
          </span>
          <h1 className="mt-0.5 text-2xl font-extrabold tracking-tight text-ink-100">
            Settings
          </h1>
        </div>
        <span
          className="rounded-lg bg-[#D1FAE5] px-2.5 py-1 text-xs font-bold text-[#065F46] transition-opacity duration-300"
          style={{ opacity: saved ? 1 : 0 }}
        >
          ✓ Saved
        </span>
      </div>

      {error && (
        <div className="mt-6">
          <ErrorNote error={error} onDismiss={() => setError(null)} />
        </div>
      )}

      {settings.insecure_secret_storage && (
        <p className="mt-6 border-l-2 border-sodium-600 pl-4 text-sm leading-relaxed text-ink-300">
          No OS keyring is available on this machine, so API keys are stored in plain text
          in <code className="text-ink-200">config.json</code>. On headless Linux, installing
          a Secret Service provider or <code className="text-ink-200">keyrings.alt</code>{' '}
          fixes this.
        </p>
      )}

      <Section title="AI provider" note="Which model picks the clips.">
        <div className="space-y-1">
          {providers.map((provider) => (
            <button
              key={provider.name}
              onClick={() => patch({ active_provider: provider.name })}
              className={[
                'block w-full border-l-2 py-3 pl-3 text-left transition-colors duration-200',
                provider.name === settings.active_provider
                  ? 'border-sodium-500 bg-ink-850/60'
                  : 'border-transparent hover:border-ink-700 hover:bg-ink-850/30',
              ].join(' ')}
            >
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-sm text-ink-100">{provider.name}</span>
                <span
                  className={`text-xs ${provider.available ? 'text-signal-good' : 'text-ink-500'}`}
                >
                  {provider.available ? 'reachable' : provider.detail || 'unavailable'}
                </span>
              </div>
              {provider.models.length > 0 && (
                <span className="numeric mt-1 block truncate text-xs text-ink-600">
                  {provider.models.slice(0, 6).join(' · ')}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <Field
            label="Model"
            value={settings.providers[settings.active_provider]?.model ?? ''}
            placeholder="model name"
            onCommit={(value) =>
              patch({
                providers: {
                  [settings.active_provider]: {
                    ...settings.providers[settings.active_provider],
                    model: value,
                  },
                },
              })
            }
          />
          <Field
            label="Base URL"
            hint="Point at OpenRouter, Groq, DeepSeek, or a local server."
            value={settings.providers[settings.active_provider]?.base_url ?? ''}
            placeholder="https://…"
            onCommit={(value) =>
              patch({
                providers: {
                  [settings.active_provider]: {
                    ...settings.providers[settings.active_provider],
                    base_url: value || null,
                  },
                },
              })
            }
          />
        </div>
      </Section>

      <Section title="Keys" note="Stored in your OS keyring. Never sent anywhere but the provider.">
        <div className="space-y-4">
          {Object.entries(SECRET_LABELS).map(([key, label]) => (
            <SecretField
              key={key}
              secretKey={key}
              label={label}
              present={settings.keys_present[key] ?? false}
              onChanged={reload}
              onError={setError}
            />
          ))}
        </div>
      </Section>

      <Section title="Transcription">
        <div className="grid gap-5 sm:grid-cols-2">
          <Select
            label="Whisper model"
            value={settings.whisper.model}
            onChange={(value) => patch({ whisper: { ...settings.whisper, model: value } })}
            options={['tiny', 'base', 'small', 'medium', 'large-v3']}
          />
          <Field
            label="Language"
            hint="Leave empty to detect automatically."
            value={settings.whisper.language}
            placeholder="auto"
            onCommit={(value) => patch({ whisper: { ...settings.whisper, language: value } })}
          />
          <div className="sm:col-span-2">
            <Field
              label="Default context prompt / keywords (optional)"
              hint="Guides Whisper on podcast name, host names, and recurring English/jargon terms. Can be customized per video on the Home page."
              value={settings.whisper.initial_prompt ?? ''}
              placeholder="Contoh: Podcast Obrolan Tiba-tiba, anime, manga, Webtoon, Marvel, Netflix"
              onCommit={(value) =>
                patch({ whisper: { ...settings.whisper, initial_prompt: value } })
              }
            />
          </div>
        </div>

        <label className="mt-5 flex items-start gap-3 text-sm text-ink-200">
          <input
            type="checkbox"
            checked={settings.whisper.diarization}
            disabled={!system?.diarization_available}
            onChange={(e) =>
              patch({ whisper: { ...settings.whisper, diarization: e.target.checked } })
            }
            className="mt-0.5 size-4 accent-sodium-500"
          />
          <span>
            Identify speakers
            {!system?.diarization_available && (
              <span className="mt-1 block text-xs text-ink-500">
                Needs the diarization extra:{' '}
                <code className="text-ink-300">uv pip install &apos;autoclip[diarization]&apos;</code>
              </span>
            )}
          </span>
        </label>

        {settings.whisper.diarization && (
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <Field
              label="Min speakers (optional)"
              hint="E.g. 3 for a 3-host single-mic podcast."
              value={settings.whisper.min_speakers != null ? String(settings.whisper.min_speakers) : ''}
              placeholder="auto"
              onCommit={(value) => {
                const parsed = value.trim() ? Number(value.trim()) : null
                if (parsed === null || (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 20)) {
                  void patch({ whisper: { ...settings.whisper, min_speakers: parsed } })
                }
              }}
            />
            <Field
              label="Max speakers (optional)"
              hint="Leave empty for automatic detection."
              value={settings.whisper.max_speakers != null ? String(settings.whisper.max_speakers) : ''}
              placeholder="auto"
              onCommit={(value) => {
                const parsed = value.trim() ? Number(value.trim()) : null
                if (parsed === null || (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 20)) {
                  void patch({ whisper: { ...settings.whisper, max_speakers: parsed } })
                }
              }}
            />
          </div>
        )}
      </Section>

      <Section title="Clips">
        <div className="grid gap-5 sm:grid-cols-3">
          <NumberField
            label="Min length (s)"
            value={settings.clips.min_duration_s}
            onCommit={(value) => patch({ clips: { ...settings.clips, min_duration_s: value } })}
          />
          <NumberField
            label="Max length (s)"
            value={settings.clips.max_duration_s}
            onCommit={(value) => patch({ clips: { ...settings.clips, max_duration_s: value } })}
          />
          <NumberField
            label="Max clips"
            value={settings.clips.max_clips}
            onCommit={(value) => patch({ clips: { ...settings.clips, max_clips: value } })}
          />
        </div>
      </Section>

      <Section title="Ingest">
        <div className="grid gap-5 sm:grid-cols-2">
          <Select
            label="YouTube cookies from"
            hint="YouTube blocks most anonymous downloads. Sign in in that browser and close it before downloading."
            value={settings.ingest.cookies_from_browser}
            onChange={(value) =>
              patch({ ingest: { ...settings.ingest, cookies_from_browser: value } })
            }
            options={['', 'chrome', 'firefox', 'edge', 'brave', 'chromium', 'safari']}
            labels={{ '': 'None' }}
          />
        </div>
      </Section>

      <Section title="Export">
        <div className="grid gap-5 sm:grid-cols-3">
          <Select
            label="Default ratio"
            value={settings.export.ratio}
            onChange={(value) => patch({ export: { ...settings.export, ratio: value } })}
            options={['9:16', '1:1', '16:9']}
          />
          <Select
            label="Quality / file size (H.264)"
            hint="CRF 23 cuts file size ~50-65% with no visible quality loss on social media."
            value={String(settings.export.crf)}
            onChange={(value) =>
              patch({ export: { ...settings.export, crf: Number(value) } })
            }
            options={
              ['18', '23', '26'].includes(String(settings.export.crf))
                ? ['18', '23', '26']
                : [String(settings.export.crf), '18', '23', '26']
            }
            labels={{
              '18': 'Master · Large (CRF 18)',
              '23': 'Visually lossless · Social (CRF 23)',
              '26': 'Compact · Smallest (CRF 26)',
            }}
          />
          <NumberField
            label="Loudness target (LUFS)"
            value={settings.export.loudness_lufs}
            onCommit={(value) => patch({ export: { ...settings.export, loudness_lufs: value } })}
          />
        </div>

        <label className="mt-5 flex items-start gap-3 text-sm text-ink-200">
          <input
            type="checkbox"
            checked={settings.export.prefer_hardware_encoder}
            onChange={(e) =>
              patch({
                export: { ...settings.export, prefer_hardware_encoder: e.target.checked },
              })
            }
            className="mt-0.5 size-4 accent-sodium-500"
          />
          <span>
            Use GPU encoding when available
            {system && !system.nvenc_works && (
              <span className="mt-1 block text-xs text-ink-500">
                Not usable on this machine — exports will use the CPU encoder. Same quality,
                slower.
              </span>
            )}
          </span>
        </label>

        <label className="mt-4 flex items-center gap-3 text-sm text-ink-200">
          <input
            type="checkbox"
            checked={settings.export.write_srt}
            onChange={(e) => patch({ export: { ...settings.export, write_srt: e.target.checked } })}
            className="size-4 accent-sodium-500"
          />
          Also write an .srt sidecar
        </label>
      </Section>

      <Section
        title="Intro Hook & Watermark"
        note="Minimalist floating headline in the first seconds + optional subtle channel handle."
      >
        <div className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-[1fr_9rem]">
            <label className="flex items-start gap-3 text-sm text-ink-200">
              <input
                type="checkbox"
                checked={settings.export.intro.enabled}
                onChange={(e) => void patchIntro({ enabled: e.target.checked })}
                className="mt-0.5 size-4 accent-sodium-500"
              />
              <span>
                Enable Intro Hook banner by default
                <span className="mt-1 block text-xs text-ink-500">
                  Shows the clip title as a minimalist floating headline for the opening seconds.
                  Can be toggled &amp; edited per clip in Review.
                </span>
              </span>
            </label>
            <NumberField
              label="Duration (s)"
              value={settings.export.intro.duration_s}
              onCommit={(value) =>
                void patchIntro({ duration_s: Math.min(8, Math.max(1, value)) })
              }
            />
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <label className="flex items-start gap-3 text-sm text-ink-200">
              <input
                type="checkbox"
                checked={settings.export.intro.watermark_enabled}
                onChange={(e) => void patchIntro({ watermark_enabled: e.target.checked })}
                className="mt-0.5 size-4 accent-sodium-500"
              />
              <span>
                Enable subtle channel watermark
                <span className="mt-1 block text-xs text-ink-500">
                  Sits cleanly in the top safe zone and fades behind the Outro CTA automatically.
                </span>
              </span>
            </label>

            <Field
              label="Watermark text (optional)"
              hint="Leave empty to reuse your YouTube handle below."
              value={settings.export.intro.watermark_text}
              placeholder={settings.export.outro.youtube_handle || '@NamaChannel'}
              onCommit={(value) => void patchIntro({ watermark_text: value })}
            />
          </div>
        </div>
      </Section>

      <Section
        title="YouTube Outro CTA"
        note="Live-blurred overlay in the final seconds of each clip — zero added duration."
      >
        <div className="grid gap-8 lg:grid-cols-[1fr_14rem]">
          <div className="space-y-5">
            <label className="flex items-start gap-3 text-sm text-ink-200">
              <input
                type="checkbox"
                checked={settings.export.outro.enabled}
                onChange={(e) => void patchOutro({ enabled: e.target.checked })}
                className="mt-0.5 size-4 accent-sodium-500"
              />
              <span>
                Enable YouTube CTA overlay by default
                <span className="mt-1 block text-xs text-ink-500">
                  Blurs the moving clip tail and shows a bridge card pointing viewers to the full
                  YouTube video. Can still be toggled per clip in Review.
                </span>
              </span>
            </label>

            <div className="grid gap-5 sm:grid-cols-[1fr_8rem]">
              <Field
                label="CTA headline"
                value={settings.export.outro.cta_text}
                placeholder="Tonton selengkapnya di YouTube"
                onCommit={(value) => void patchOutro({ cta_text: value })}
              />
              <NumberField
                label="Duration (s)"
                value={settings.export.outro.duration_s}
                onCommit={(value) =>
                  void patchOutro({ duration_s: Math.min(8, Math.max(1, value)) })
                }
              />
            </div>

            <Field
              label="YouTube channel / @handle"
              hint="Leave empty to auto-fill from the ingested YouTube channel name."
              value={settings.export.outro.youtube_handle}
              placeholder="@NamaChannel"
              onCommit={(value) => void patchOutro({ youtube_handle: value })}
            />

            <label className="flex items-center gap-3 text-sm text-ink-200">
              <input
                type="checkbox"
                checked={settings.export.outro.show_video_title}
                onChange={(e) => void patchOutro({ show_video_title: e.target.checked })}
                className="size-4 accent-sodium-500"
              />
              Auto-show full YouTube video title on the card
            </label>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label="Instagram handle (optional)"
                value={settings.export.outro.instagram_handle}
                placeholder="@instagram"
                onCommit={(value) => void patchOutro({ instagram_handle: value })}
              />
              <Field
                label="TikTok handle (optional)"
                value={settings.export.outro.tiktok_handle}
                placeholder="@tiktok"
                onCommit={(value) => void patchOutro({ tiktok_handle: value })}
              />
            </div>
          </div>

          <div className="flex flex-col items-center">
            <div className="mb-2 flex w-full items-center justify-between">
              <span className="eyebrow">Preview</span>
              <div className="flex gap-1">
                {PREVIEW_RATIOS.map((ratio) => (
                  <button
                    key={ratio}
                    type="button"
                    onClick={() => setPreviewRatio(ratio)}
                    className={[
                      'numeric px-1.5 py-0.5 text-[11px] transition-colors',
                      previewRatio === ratio
                        ? 'bg-sodium-500 text-ink-950'
                        : 'text-ink-400 hover:text-ink-100',
                    ].join(' ')}
                  >
                    {ratio}
                  </button>
                ))}
              </div>
            </div>
            <div className="w-full overflow-hidden border border-ink-800 bg-ink-900">
              <img
                src={api.outroPreviewUrl(previewRatio, previewVersion)}
                alt="Outro CTA overlay preview"
                className="block h-auto w-full"
              />
            </div>
          </div>
        </div>
      </Section>

      {system && (
        <Section title="This machine">
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <Row label="Platform" value={system.platform} />
            <Row label="Python" value={system.python_version} />
            <Row label="ffmpeg" value={system.ffmpeg_version ?? 'not found'} />
            <Row label="Acceleration" value={system.accel.toUpperCase()} />
            <Row label="Device" value={system.gpu_name ?? '—'} />
            <Row label="Whisper compute" value={system.compute_type} />
            <Row label="GPU encode" value={system.nvenc_works ? 'available' : 'unavailable'} />
            <Row label="Captions" value={system.has_libass ? 'libass present' : 'libass missing'} />
          </dl>
        </Section>
      )}
    </div>
  )
}

function Section({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <section className="studio-card rise p-6">
      <div className="border-b border-ink-800 pb-3">
        <h2 className="text-sm font-extrabold text-ink-100">{title}</h2>
        {note && <p className="mt-0.5 text-xs text-ink-500">{note}</p>}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-ink-850 pb-2">
      <dt className="text-ink-500">{label}</dt>
      <dd className="numeric truncate text-right text-ink-200">{value}</dd>
    </div>
  )
}

/** Commits on blur rather than per keystroke, so a PUT isn't fired per letter. */
function Field({
  label,
  hint,
  value,
  placeholder,
  onCommit,
}: {
  label: string
  hint?: string
  value: string
  placeholder?: string
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      <input
        className="field mt-1 text-sm"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onCommit(draft)}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        spellCheck={false}
      />
      {hint && <span className="mt-1.5 block text-xs leading-snug text-ink-500">{hint}</span>}
    </label>
  )
}

function NumberField({
  label,
  value,
  onCommit,
}: {
  label: string
  value: number
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])

  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      <input
        type="number"
        className="field numeric mt-1 text-sm"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const parsed = Number(draft)
          if (!Number.isNaN(parsed) && parsed !== value) onCommit(parsed)
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    </label>
  )
}

function Select({
  label,
  hint,
  value,
  onChange,
  options,
  labels = {},
}: {
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
  options: string[]
  labels?: Record<string, string>
}) {
  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      <select
        className="field mt-1 cursor-pointer text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option} className="bg-ink-850">
            {labels[option] ?? option}
          </option>
        ))}
      </select>
      {hint && <span className="mt-1.5 block text-xs leading-snug text-ink-500">{hint}</span>}
    </label>
  )
}

function SecretField({
  secretKey,
  label,
  present,
  onChanged,
  onError,
}: {
  secretKey: string
  label: string
  present: boolean
  onChanged: () => void
  onError: (error: Error) => void
}) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (!value.trim()) return
    setBusy(true)
    try {
      await api.putSecret(secretKey, value.trim())
      setValue('')
      onChanged()
    } catch (err) {
      onError(err as Error)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await api.deleteSecret(secretKey)
      onChanged()
    } catch (err) {
      onError(err as Error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-56 flex-1">
        <span className="eyebrow">
          {label}
          {present && <span className="ml-2 text-signal-good">set</span>}
        </span>
        <input
          type="password"
          className="field mt-1 text-sm"
          value={value}
          placeholder={present ? '••••••••••••' : 'paste to add'}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          autoComplete="off"
        />
      </label>
      <button onClick={save} disabled={!value.trim() || busy} className="btn btn-ghost">
        Save
      </button>
      {present && (
        <button onClick={remove} disabled={busy} className="btn btn-quiet">
          Remove
        </button>
      )}
    </div>
  )
}
