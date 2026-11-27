import { useEffect, useMemo, useState } from 'react'

import { formatTimecode, type Word } from '../api'
import { SPEAKER_PALETTE } from './ClipPlayer'

/**
 * Word-level caption editing.
 *
 * The job here is fixing what Whisper misheard — names, jargon, acronyms. Only
 * the text is editable; timings stay locked to the measured audio, because a
 * hand-typed timestamp is how captions drift out of sync.
 */
export function CaptionEditor({
  words,
  onChange,
  onSave,
  saving,
  dirty,
}: {
  words: Word[]
  onChange: (words: Word[]) => void
  onSave: () => void
  saving: boolean
  dirty: boolean
}) {
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => setEditing(null), [words.length])

  const speakerBadges = useMemo(() => {
    const seen: string[] = []
    for (const word of words) {
      if (word.speaker && !seen.includes(word.speaker)) {
        seen.push(word.speaker)
      }
    }
    const map = new Map<string, { label: string; color: string }>()
    if (seen.length < 2) return map
    seen.forEach((speaker, idx) => {
      map.set(speaker, {
        label: `S${idx + 1}`,
        color: SPEAKER_PALETTE[idx % SPEAKER_PALETTE.length],
      })
    })
    return map
  }, [words])

  const commit = (index: number) => {
    const text = draft.trim()
    if (text && text !== words[index].text) {
      const next = words.map((word, i) => (i === index ? { ...word, text } : word))
      onChange(next)
    }
    setEditing(null)
  }

  if (words.length === 0) {
    return (
      <p className="text-sm text-ink-500">
        No transcript for this clip yet.
      </p>
    )
  }

  return (
    <div>
      <div className="flex items-baseline justify-between border-b border-ink-800 pb-2">
        <span className="eyebrow">Transcript</span>
        <div className="flex items-center gap-3">
          {speakerBadges.size >= 2 && (
            <span className="flex items-center gap-2 text-[11px] text-ink-400">
              {Array.from(speakerBadges.entries()).map(([spk, info]) => (
                <span key={spk} className="inline-flex items-center gap-1">
                  <span
                    className="inline-block size-2 rounded-full"
                    style={{ backgroundColor: info.color }}
                  />
                  <span>{info.label}</span>
                </span>
              ))}
            </span>
          )}
          <span className="numeric text-xs text-ink-600">{words.length} words</span>
        </div>
      </div>

      {/* Words flow as text, not as a list of rows — reading it back is the
          main way you notice a mistranscription. */}
      <div className="mt-4 max-h-[38vh] overflow-y-auto pr-1 text-[0.9375rem] leading-[1.9]">
        {words.map((word, index) => {
          const badge = word.speaker ? speakerBadges.get(word.speaker) : undefined
          const showBadge =
            badge && (index === 0 || words[index - 1].speaker !== word.speaker)
          return (
            <span key={index} className="inline">
              {showBadge && (
                <span
                  className="mr-1 inline-flex items-center rounded px-1 py-0.5 align-middle text-[10px] font-bold leading-none"
                  style={{
                    color: badge.color,
                    border: `1px solid ${badge.color}55`,
                    backgroundColor: `${badge.color}18`,
                  }}
                >
                  {badge.label}
                </span>
              )}
              {editing === index ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commit(index)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit(index)
                    if (e.key === 'Escape') setEditing(null)
                    if (e.key === 'Tab') {
                      e.preventDefault()
                      commit(index)
                      const next = index + (e.shiftKey ? -1 : 1)
                      if (next >= 0 && next < words.length) {
                        setDraft(words[next].text)
                        setEditing(next)
                      }
                    }
                  }}
                  className="mr-1 w-[8ch] border-b border-sodium-500 bg-transparent px-0.5 text-ink-100 outline-none"
                  style={{ width: `${Math.max(4, draft.length + 1)}ch` }}
                />
              ) : (
                <button
                  onClick={() => {
                    setDraft(word.text)
                    setEditing(index)
                  }}
                  title={formatTimecode(word.start)}
                  className="mr-1 rounded-[2px] px-0.5 text-ink-200 transition-colors duration-150 hover:bg-sodium-700/25 hover:text-ink-100"
                >
                  {word.text}
                </button>
              )}
            </span>
          )
        })}
      </div>

      <div className="mt-4 flex items-center gap-4">
        <button onClick={onSave} disabled={!dirty || saving} className="btn btn-ghost">
          {saving ? 'Saving…' : 'Save edits'}
        </button>
        <span className="text-xs text-ink-500">
          {dirty ? 'Unsaved changes' : 'Click any word to correct it'}
        </span>
      </div>
    </div>
  )
}
