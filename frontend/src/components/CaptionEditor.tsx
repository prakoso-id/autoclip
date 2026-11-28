import { useEffect, useMemo, useState } from 'react'

import { formatTimecode, type Word } from '../api'

interface SpeakerStyle {
  label: string
  borderColor: string
  headerColor: string
  dotColor: string
}

const SPEAKER_STYLES: SpeakerStyle[] = [
  {
    label: 'SPEAKER 1',
    borderColor: '#EAB308',
    headerColor: '#B45309',
    dotColor: '#EAB308',
  },
  {
    label: 'SPEAKER 2',
    borderColor: '#06B6D4',
    headerColor: '#0E7490',
    dotColor: '#06B6D4',
  },
  {
    label: 'SPEAKER 3',
    borderColor: '#10B981',
    headerColor: '#047857',
    dotColor: '#10B981',
  },
  {
    label: 'SPEAKER 4',
    borderColor: '#E11D48',
    headerColor: '#BE123C',
    dotColor: '#E11D48',
  },
]

interface DialogueTurn {
  speakerKey: string | null
  style: SpeakerStyle
  startS: number
  items: { word: Word; index: number }[]
}

/**
 * Per-speaker dialogue turn editor (Concept 4 — Daylight Tactile Studio).
 *
 * Groups consecutive words by speaker into tactile dialogue cards with a
 * colored left border and timestamp header. Every word remains individually
 * clickable to fix Whisper typos without touching word timings.
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

  const { turns, speakerCount } = useMemo(() => {
    const seenSpeakers: string[] = []
    for (const w of words) {
      if (w.speaker && !seenSpeakers.includes(w.speaker)) {
        seenSpeakers.push(w.speaker)
      }
    }

    const styleFor = (speaker: string | null): SpeakerStyle => {
      if (!speaker) return SPEAKER_STYLES[0]
      const idx = Math.max(0, seenSpeakers.indexOf(speaker))
      const base = SPEAKER_STYLES[idx % SPEAKER_STYLES.length]
      return {
        ...base,
        label: `SPEAKER ${idx + 1}`,
      }
    }

    const grouped: DialogueTurn[] = []
    for (let i = 0; i < words.length; i += 1) {
      const word = words[i]
      const prev = grouped[grouped.length - 1]
      const sameSpeaker = prev && prev.speakerKey === (word.speaker ?? null)
      // When no diarization labels exist, split into readable paragraphs every 24 words.
      const splitParagraph = !word.speaker && prev && prev.items.length >= 24

      if (!prev || !sameSpeaker || splitParagraph) {
        grouped.push({
          speakerKey: word.speaker ?? null,
          style: styleFor(word.speaker ?? null),
          startS: word.start,
          items: [{ word, index: i }],
        })
      } else {
        prev.items.push({ word, index: i })
      }
    }

    return { turns: grouped, speakerCount: Math.max(1, seenSpeakers.length) }
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
    return <p className="text-sm text-[#737168]">No transcript for this clip yet.</p>
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="eyebrow">Speaker Dialogue (Click word to fix typo)</span>
        <span className="numeric text-xs font-medium text-[#737168]">
          {speakerCount > 1 ? `${speakerCount} Hosts Detected` : `${words.length} words`}
        </span>
      </div>

      <div className="mt-2.5 max-h-[36vh] space-y-2.5 overflow-y-auto pr-1">
        {turns.map((turn, tIdx) => (
          <div
            key={`${tIdx}-${turn.startS}`}
            className="rounded-xl border border-[#EAE8E1] bg-[#F8F7F4] px-3.5 py-2.5 text-[13.5px] leading-relaxed"
            style={{ borderLeft: `3.5px solid ${turn.style.borderColor}` }}
          >
            <div
              className="numeric mb-1 text-[11px] font-extrabold tracking-wide"
              style={{ color: turn.style.headerColor }}
            >
              {turn.style.label} · {formatTimecode(turn.startS)}
            </div>

            <div>
              {turn.items.map(({ word, index }) => (
                <span key={index} className="inline">
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
                      className="mr-1 rounded bg-[#FEF08A] px-1 font-bold text-[#171715] outline-none ring-1 ring-[#171715]"
                      style={{ width: `${Math.max(4, draft.length + 1)}ch` }}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setDraft(word.text)
                        setEditing(index)
                      }}
                      title={`Click to edit (${formatTimecode(word.start)})`}
                      className="mr-1 cursor-pointer rounded px-0.5 text-[#171715] transition-colors duration-100 hover:bg-[#FEF08A] hover:font-semibold"
                    >
                      {word.text}
                    </button>
                  )}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {dirty && (
        <div className="mt-3 flex items-center justify-between rounded-xl border border-[#FDE68A] bg-[#FFFBEB] px-3 py-2">
          <span className="text-xs font-semibold text-[#92400E]">
            Unsaved word corrections
          </span>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="btn btn-dark min-h-8 px-3 py-1 text-xs"
          >
            {saving ? 'Saving…' : 'Save Transcript'}
          </button>
        </div>
      )}
    </div>
  )
}
