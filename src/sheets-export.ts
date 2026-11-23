import { formatCompactSet, type ExerciseFeedback, type Session } from './workouts'

export const sheetsHeaders = ['.', 'Date', 'Day', 'Exercise', 'Target', 'Actual', 'RIR', 'Mobility', 'Pain/Notes', 'Coach Notes'] as const
type Cells<Headers extends readonly string[]> = { [Index in keyof Headers]: string | undefined }

const sheetsMobilityLabels = {
  Great: '🟢 Great',
  Tight: '🟡 Tight',
  'Very tight': '🔴 Very tight',
} satisfies Record<NonNullable<ExerciseFeedback['mobility']>, string>

function safeCell(value = '') {
  const singleLine = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
  // Treat formula prefixes and leading quotes as literal text when pasted.
  return /^[\s\p{Cf}]*[=+@＝＋－＠"'-]/u.test(singleLine) ? `'${singleLine}` : singleLine
}

export function sheetsRows(session: Session, day: string) {
  return session.exercises.map((exercise, index) => {
    const slots = session.guidance?.sets[index]
    // Older snapshots may only have actuals. A live plan cannot supply their historical targets.
    const targets = slots?.map(set => set.target) ?? exercise.prescription ?? []
    const actual = slots ? slots.flatMap(({ outcome }) => {
      if (outcome?.status === 'recorded') return [formatCompactSet(outcome.actual)]
      if (outcome?.status === 'skipped') return [outcome.reason ? `Skipped (${outcome.reason})` : 'Skipped']
      return []
    }) : exercise.sets.map(formatCompactSet)
    const { rir, mobility, painNotes, coachNotes } = exercise.feedback ?? {}
    const row: Cells<typeof sheetsHeaders> = [
      'CURRENT WEEK', session.date, day, exercise.name, targets.map(formatCompactSet).join(' | '),
      actual.join(' | '), rir, mobility && sheetsMobilityLabels[mobility], painNotes, coachNotes,
    ]
    return row.map(safeCell)
  })
}

export function sheetsTsv(rows: readonly (readonly string[])[]) {
  return rows.map(row => row.join('\t')).join('\n')
}
