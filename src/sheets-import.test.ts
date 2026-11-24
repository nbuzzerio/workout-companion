import { expect, test } from 'vitest'
import { recordFeedback, recordSet, skipSets, startGuidedWorkout } from './guided-workout'
import { sheetsHeaders, sheetsRows, sheetsTsv } from './sheets-export'
import { parseSheetsWorkout, type SheetsExercise } from './sheets-import'
import { demoPlan, formatCompactSet, validateSession, type Plan } from './workouts'

const date = '2026-11-18'
const day = 'Mon'
const exercises: SheetsExercise[] = [
  { name: 'DB Deadlift', targets: [
    { kind: 'weight', pounds: 46, reps: 10 },
    { kind: 'weight', pounds: 55.5, reps: 8, perSide: true },
  ] },
  { name: 'Leg Extension', targets: [
    { kind: 'machine', position: 'P9', reps: 12, perSide: true },
    { kind: 'machine', position: 'P10', reps: 10 },
  ] },
  { name: 'Side Plank', targets: [{ kind: 'hold', seconds: 35.5, perSide: true }] },
  { name: 'Band Pull', targets: [{ kind: 'band', resistance: 'Heavy green', reps: 12 }] },
  { name: 'Lunge', targets: [{ kind: 'bodyweight', reps: 6, perSide: true }] },
  { name: 'DB Deadlift', targets: [{ kind: 'weight', pounds: 0, reps: 0 }] },
  { name: 'Walk', targets: [{ kind: 'freeform', value: '0.5 mi in 8:00' }] },
  { name: 'Optional Cooldown', targets: [] },
]

function workoutPlan(items: SheetsExercise[]): Plan {
  return {
    ...demoPlan,
    exercises: items.map(({ name, targets }, index) => ({ id: `exercise-${index}`, name, sets: [], prescription: targets })),
  }
}

function exportedRows() {
  let previous = startGuidedWorkout(workoutPlan(exercises), date)
  previous = recordSet(previous, { kind: 'weight', pounds: 40, reps: 6 }, true)
  previous = skipSets(previous, 'set', 'Fatigue | back felt tight')
  previous = recordFeedback(previous, 0, { rir: '4+', mobility: 'Tight', painNotes: 'Sore\nthen fine', coachNotes: 'Lower slowly' })
  previous = recordFeedback(previous, 7, { coachNotes: 'Optional today' })
  return sheetsRows(previous, day)
}

test.each([false, true])('imports exported exercise order and targets with headers=%s', withHeaders => {
  const rows = exportedRows()
  expect(rows[0].slice(5)).toEqual(['40 lb×6 | Skipped (Fatigue | back felt tight)', '4+', '🟡 Tight', 'Sore then fine', 'Lower slowly'])
  expect(rows[7][4]).toBe('')
  const result = parseSheetsWorkout(sheetsTsv(withHeaders ? [sheetsHeaders, ...rows] : rows))
  const expected = exercises.map((exercise, index) => ({
    ...exercise,
    actuals: index === 0 ? [{ kind: 'weight', pounds: 40, reps: 6 }] : [],
    ...(index === 0 && { coachNotes: 'Lower slowly' }),
    ...(index === 7 && { coachNotes: 'Optional today' }),
  }))
  expect(result).toEqual({ date, day, exercises: expected })

  const fresh = startGuidedWorkout(workoutPlan(result.exercises), date)
  validateSession(fresh)
  expect(fresh.guidance).toEqual({ cursor: 0, sets: exercises.map(exercise => exercise.targets.map(target => ({ target }))) })
  expect(fresh.exercises.every(exercise => exercise.sets.length === 0 && exercise.feedback === undefined)).toBe(true)
  expect(sheetsRows(fresh, day).every(row => row.slice(5).every(cell => cell === ''))).toBe(true)
})

const row = (name = 'DB Deadlift', target = '46 lb×10', rowDate = date, rowDay = day) =>
  ['CURRENT WEEK', rowDate, rowDay, name, target, '', '', '', '', '']

test.each(['\n', '\r\n'])('reads quoted Sheets cells and optional blanks with line ending %j', newline => {
  const target = `3×8 at RPE 7${newline}Pause at the bottom\t"2 sec"`
  const text = [
    '\uFEFF',
    sheetsTsv([sheetsHeaders]),
    `CURRENT WEEK\t${date}\t${day}\t"DB ""Tempo"" Press"\t"${target.replaceAll('"', '""')}"\t\t\t\t"Sore${newline}after warmup"\t"Coach said ""keep going"""`,
    '\t'.repeat(9),
    row('Side Plank', '0 sec').join('\t'),
    '',
  ].join(newline)
  expect(parseSheetsWorkout(text).exercises).toEqual([
    { name: 'DB "Tempo" Press', targets: [{ kind: 'freeform', value: target }], actuals: [], coachNotes: 'Coach said "keep going"' },
    { name: 'Side Plank', targets: [{ kind: 'hold', seconds: 0 }], actuals: [] },
  ])
})

test('preserves range, set-count, timing and other unstructured notation alongside compact targets', () => {
  const target = '3×8–12 | 1:30 on/0:30 off | 12.5 lb×6 | 2×AMRAP | RPE 6|7'
  const [exercise] = parseSheetsWorkout(sheetsTsv([row('Circuit', target)])).exercises
  expect(exercise.targets).toEqual([
    { kind: 'freeform', value: '3×8–12' },
    { kind: 'freeform', value: '1:30 on/0:30 off' },
    { kind: 'weight', pounds: 12.5, reps: 6 },
    { kind: 'freeform', value: '2×AMRAP' },
    { kind: 'freeform', value: 'RPE 6|7' },
  ])
  expect(exercise.targets.map(formatCompactSet).join(' | ')).toBe(target)
})

test('retains text with a literal separator followed by a blank segment', () => {
  const target = 'Work up to a comfortable weight | '
  expect(parseSheetsWorkout(sheetsTsv([row('Squat', target)])).exercises[0].targets).toEqual([{ kind: 'freeform', value: target }])
})

test('keeps formula-like cell contents as literal strings, including exporter-escaped cells', () => {
  const input = [
    { name: '"Tempo" Press', targets: [{ kind: 'freeform', value: '=SUM(1,2)' }] },
    { name: "'90s Squat", targets: [{ kind: 'freeform', value: '+ challenge set' }] },
  ] satisfies SheetsExercise[]
  const previous = startGuidedWorkout(workoutPlan(input), date)
  const rows = sheetsRows(previous, day)
  expect(rows[0].slice(3, 5)).toEqual([`'"Tempo" Press`, "'=SUM(1,2)"])
  expect(parseSheetsWorkout(sheetsTsv(rows)).exercises).toEqual(input.map(exercise => ({ ...exercise, actuals: [] })))
  expect(parseSheetsWorkout(sheetsTsv([row('=1+1 Press', '=SUM(1,2)')])).exercises).toEqual([
    { name: '=1+1 Press', targets: [{ kind: 'freeform', value: '=SUM(1,2)' }], actuals: [] },
  ])
})

test('reads Actuals from legacy and edited exports and keeps blank and skip-only prescriptions empty', () => {
  const edited = row('Updated exercise', '12.50 lb×6')
  edited[5] = 'Skipped | Bodyweight×0 per side | Skipped (Pain (left) | stopped early) | P10×12 | 35 sec per side | Skipped'
  edited[9] = "'+ set the pin first"
  const legacy = row('Legacy exercise', '')
  legacy[5] = '0 lb×0 | Steady pace'
  const skipped = row('Skipped exercise', '35 sec')
  skipped[5] = 'Skipped (Fatigue | shoulder (left))'
  const blank = row('Optional cooldown', '')
  const { exercises } = parseSheetsWorkout(sheetsTsv([edited, legacy, skipped, blank]))
  expect(exercises).toEqual([
    { name: 'Updated exercise', targets: [{ kind: 'freeform', value: '12.50 lb×6' }], actuals: [
      { kind: 'bodyweight', reps: 0, perSide: true },
      { kind: 'machine', position: 'P10', reps: 12 },
      { kind: 'hold', seconds: 35, perSide: true },
    ], coachNotes: '+ set the pin first' },
    { name: 'Legacy exercise', targets: [], actuals: [{ kind: 'weight', pounds: 0, reps: 0 }, { kind: 'freeform', value: 'Steady pace' }] },
    { name: 'Skipped exercise', targets: [{ kind: 'hold', seconds: 35 }], actuals: [] },
    { name: 'Optional cooldown', targets: [], actuals: [] },
  ])
})

test.each([
  ['2026-11-25', 'Mon'],
  [date, 'Wed'],
])('rejects rows from a second Date or Day (%s %s)', (otherDate, otherDay) => {
  const tsv = sheetsTsv([sheetsHeaders, row(), row('Side Plank', '40 sec', otherDate, otherDay)])
  expect(() => parseSheetsWorkout(tsv)).toThrow(`Lines 2 and 3 have different workout days (${date} ${day} and ${otherDate} ${otherDay}). Copy rows for one Date and Day at a time.`)
})

test.each([
  ['', /No exercises found/u],
  [sheetsTsv([sheetsHeaders]), /No exercises found/u],
  [sheetsTsv([row().slice(0, -1)]), /Line 1 has 9 columns.*Copy all 10/u],
  [sheetsTsv([[...row(), 'Unexpected cell']]), /Line 1 has 11 columns.*Copy all 10/u],
  [sheetsTsv([['', ...row().slice(1)]]), /Line 1 must start with the CURRENT WEEK marker/u],
  [sheetsTsv([row('Squat', '46 lb×10', '2026-02-29')]), /Line 1 needs a valid Date in YYYY-MM-DD format/u],
  [sheetsTsv([row('Squat', '46 lb×10', date, '')]), /Line 1 is missing a Day/u],
  [sheetsTsv([sheetsHeaders, row(), row(' ')]), /Line 3 is missing an Exercise name/u],
  [sheetsTsv([[...sheetsHeaders.slice(0, 4), 'Actual', 'Target', ...sheetsHeaders.slice(6)], row()]), /Line 1 has an unexpected header/u],
  [sheetsTsv([row(), sheetsHeaders, row()]), /Line 2 has an unexpected header/u],
])('rejects incomplete or malformed selections (%j)', (input, error) => {
  expect(() => parseSheetsWorkout(input)).toThrow(error)
})

test('reports a malformed row after a quoted newline by its physical start line', () => {
  const tsv = sheetsTsv([sheetsHeaders, row('Side Plank', '"Hold for\n40 sec"'), row().slice(0, 8)])
  expect(() => parseSheetsWorkout(tsv)).toThrow(/Line 4 has 8 columns/u)
})

test.each([
  ['"Hold for\r\n40 sec', /Row starting on line 2, column 5 is missing a closing quote/u],
  ['"Hold for\n40 sec"extra', /Line 3, column 5 has text after a closing quote/u],
])('explains invalid quoted cells (%j)', (target, error) => {
  expect(() => parseSheetsWorkout(sheetsTsv([sheetsHeaders, row('Side Plank', target)]))).toThrow(error)
})
