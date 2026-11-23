import { expect, test } from 'vitest'
import { recordFeedback, recordSet, skipSets, startGuidedWorkout } from './guided-workout'
import { sheetsHeaders, sheetsRows, sheetsTsv } from './sheets-export'
import { createSession, demoPlan, type Plan } from './workouts'

test('exports exact TSV in workout order with original targets, recorded sets, skips and feedback', () => {
  const plan: Plan = {
    ...demoPlan,
    exercises: [
      ...demoPlan.exercises,
      { id: 'hold', name: 'Side Plank', sets: [{ kind: 'hold', seconds: 40, perSide: true }] },
      { id: 'pull', name: 'Band Pull', sets: [], prescription: [{ kind: 'band', resistance: 'Green', reps: 12 }] },
      { id: 'lunge', name: 'Lunge', sets: [], prescription: [{ kind: 'bodyweight', reps: 6, perSide: true }] },
      { id: 'walk', name: 'Walk', sets: [], prescription: [{ kind: 'freeform', value: '0.5 mi in 8:00' }] },
      { id: 'empty', name: 'Optional Cooldown', sets: [] },
    ],
  }
  let session = startGuidedWorkout(plan, '2026-11-18')
  for (const [pounds, reps] of [[46, 10], [55, 8], [63, 8]]) {
    session = recordSet(session, { kind: 'weight', pounds, reps }, true)
  }
  session = skipSets(session, 'set', 'Fatigue')
  session = recordFeedback(session, 0, {
    rir: '4+', mobility: 'Tight', painNotes: 'Left side sore\nNo pain', coachNotes: 'Slow the lowering',
  })
  session = recordSet(session, { kind: 'machine', position: 'P9', reps: 11, perSide: true }, true)
  session = recordSet(session, { kind: 'machine', position: 'P10', reps: 9 }, true)
  session = recordFeedback(session, 1, { rir: '0', mobility: 'Great' })
  session = skipSets(session, 'exercise', 'Time limit')
  session = recordFeedback(session, 2, { rir: 'N/A', mobility: 'Very tight', coachNotes: 'Try again next time' })
  session = recordSet(session, { kind: 'hold', seconds: 35.5, perSide: true }, true)
  session = recordSet(session, { kind: 'band', resistance: 'Blue', reps: 10 }, true)
  session = recordSet(session, { kind: 'bodyweight', reps: 5, perSide: true }, true)
  session = recordSet(session, { kind: 'freeform', value: '0.6 mi in 9:15' }, true)
  session.status = 'completed'
  const snapshot = structuredClone(session)

  const rows = sheetsRows(session, 'Mon')
  const withHeaders = sheetsTsv([sheetsHeaders, ...rows])
  expect(withHeaders).toBe([
    '.\tDate\tDay\tExercise\tTarget\tActual\tRIR\tMobility\tPain/Notes\tCoach Notes',
    'CURRENT WEEK\t2026-11-18\tMon\tDB Deadlift\t46 lb×10 | 55 lb×10 | 63 lb×10 | 72 lb×8\t46 lb×10 | 55 lb×8 | 63 lb×8 | Skipped (Fatigue)\t4+\t🟡 Tight\tLeft side sore No pain\tSlow the lowering',
    'CURRENT WEEK\t2026-11-18\tMon\tLeg Extension\tP9×12 | P10×10\tP9×11 per side | P10×9\t0\t🟢 Great\t\t',
    'CURRENT WEEK\t2026-11-18\tMon\tSeated Military Press\t20 lb×10\tSkipped (Time limit)\tN/A\t🔴 Very tight\t\tTry again next time',
    'CURRENT WEEK\t2026-11-18\tMon\tSide Plank\t40 sec per side\t35.5 sec per side\t\t\t\t',
    'CURRENT WEEK\t2026-11-18\tMon\tBand Pull\tGreen band×12\tBlue band×10\t\t\t\t',
    'CURRENT WEEK\t2026-11-18\tMon\tLunge\tBodyweight×6 per side\tBodyweight×5 per side\t\t\t\t',
    'CURRENT WEEK\t2026-11-18\tMon\tWalk\t0.5 mi in 8:00\t0.6 mi in 9:15\t\t\t\t',
    'CURRENT WEEK\t2026-11-18\tMon\tOptional Cooldown\t\t\t\t\t\t',
  ].join('\n'))
  expect(rows).toHaveLength(8)
  expect(withHeaders.split('\n').map(row => row.split('\t').length)).toEqual(Array(9).fill(10))
  expect(sheetsTsv(rows)).toBe(withHeaders.split('\n').slice(1).join('\n'))
  expect(session).toEqual(snapshot)
})

test('keeps legacy actuals and uses a historical prescription only when present', () => {
  const session = createSession(demoPlan, '2024-02-29')
  session.status = 'completed'
  session.exercises[0].sets = [{ kind: 'weight', pounds: 0, reps: 0 }]
  session.exercises[1].prescription = [{ kind: 'machine', position: 'P9', reps: 12, perSide: true }]
  session.exercises[1].sets = [{ kind: 'machine', position: 'P10', reps: 10 }]

  const rows = sheetsRows(session, 'Thu')
  expect(rows[0]).toEqual(['CURRENT WEEK', '2024-02-29', 'Thu', 'DB Deadlift', '', '0 lb×0', '', '', '', ''])
  expect(rows[1].slice(4, 6)).toEqual(['P9×12 per side', 'P10×10'])
})

test('flattens embedded tabs and line breaks in every free text column and neutralizes formula prefixes', () => {
  const session = startGuidedWorkout({
    ...demoPlan,
    exercises: [{
      id: 'custom', name: '\t=1+1\r\nPress', sets: [],
      prescription: [{ kind: 'freeform', value: ' ＋2\u2028target' }],
    }],
  }, '2026-11-16')
  const recorded = recordSet(session, { kind: 'freeform', value: '\u200b@SUM(1,2)\tactual' }, true)
  const finished = recordFeedback(recorded, 0, { painNotes: '-1\r\npain', coachNotes: '+1\tcoach' })
  finished.status = 'completed'
  const tsv = sheetsTsv(sheetsRows(finished, 'Mon'))
  expect(tsv.split('\n')).toHaveLength(1)
  expect(tsv.split('\t')).toEqual([
    'CURRENT WEEK', '2026-11-16', 'Mon', "' =1+1 Press",
    "' ＋2 target", "'\u200b@SUM(1,2) actual", '', '', "'-1 pain", "'+1 coach",
  ])
})

test('an unset result is blank and a leading quote remains literal', () => {
  const session = startGuidedWorkout(demoPlan, '2026-11-16')
  const edited = recordFeedback(session, 0, { coachNotes: '"quoted note" with\ttab' })
  expect(sheetsRows(edited, 'Mon')[0].slice(5)).toEqual(['', '', '', '', `'"quoted note" with tab`])
})
