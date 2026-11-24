import { sheetsHeaders, sheetsSetSeparator, sheetsWeekMarker, unescapeSheetsExportCell } from './sheets-export'
import { assertDate, formatCompactSet, performanceSchema, type Performance } from './workouts'

export interface SheetsExercise {
  name: string
  targets: Performance[]
  coachNotes?: string
}

export interface SheetsWorkout {
  date: string
  day: string
  exercises: (SheetsExercise & { actuals: Performance[] })[]
}

interface SheetsRow { line: number; cells: string[] }

function* readRows(input: string): Generator<SheetsRow> {
  let cells: string[] = []
  let cell = ''
  let state: 'unquoted' | 'quoted' | 'closed' = 'unquoted'
  let line = 1
  let rowLine = 1

  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    const next = input[index + 1]
    const newline = char === '\r' || char === '\n'
    const crlf = char === '\r' && next === '\n'

    if (state === 'quoted') {
      if (char === '"' && next === '"') {
        cell += '"'
        index++
      } else if (char === '"') {
        state = 'closed'
      } else {
        cell += crlf ? '\r\n' : char
        if (newline) line++
        if (crlf) index++
      }
      continue
    }

    if (char === '\t' || newline) {
      cells.push(cell)
      cell = ''
      state = 'unquoted'
      if (newline) {
        yield { line: rowLine, cells }
        cells = []
        rowLine = ++line
        if (crlf) index++
      }
    } else if (state === 'closed') {
      throw new Error(`Line ${line}, column ${cells.length + 1} has text after a closing quote. Copy the cell again or double any quotes inside it.`)
    } else if (char === '"' && cell === '') {
      state = 'quoted'
    } else {
      cell += char
    }
  }

  if (state === 'quoted') {
    throw new Error(`Row starting on line ${rowLine}, column ${cells.length + 1} is missing a closing quote. Copy the complete row again.`)
  }
  yield { line: rowLine, cells: [...cells, cell] }
}

const quantity = String.raw`(\d+(?:\.\d+)?(?:e[+-]?\d+)?)`
const holdTarget = new RegExp(`^${quantity} sec( per side)?$`, 'u')
const weightTarget = new RegExp(`^${quantity} lb$`, 'u')

function readCompactTarget(value: string): Performance | undefined {
  const hold = holdTarget.exec(value)
  if (hold) return { kind: 'hold', seconds: Number(hold[1]), ...(hold[2] && { perSide: true }) }

  const match = /^(.+)×(\d+)( per side)?$/su.exec(value)
  if (!match) return

  const [, load, repText, side] = match
  const reps = Number(repText)
  const perSide = side ? { perSide: true } : {}
  const weight = weightTarget.exec(load)
  if (weight) return { kind: 'weight', pounds: Number(weight[1]), reps, ...perSide }
  if (/^P\d+$/u.test(load)) return { kind: 'machine', position: load, reps, ...perSide }
  if (load === 'Bodyweight') return { kind: 'bodyweight', reps, ...perSide }
  if (load.endsWith(' band')) return { kind: 'band', resistance: load.slice(0, -' band'.length), reps, ...perSide }
}

function withoutSkips(values: string[]): string[] {
  const measurements: string[] = []

  for (let index = 0; index < values.length; index++) {
    const value = values[index]
    if (value === 'Skipped') continue
    if (value.startsWith('Skipped (')) {
      // Reasons can contain the set separator or parentheses of their own.
      let depth = 0
      let end: number | undefined
      for (let part = index; part < values.length; part++) {
        for (const [bracket] of values[part].matchAll(/[()]/gu)) depth += bracket === '(' ? 1 : -1
        if (!values[part].endsWith(')')) continue
        // Keep a fallback for exported reasons with unmatched parentheses.
        end ??= part
        if (depth === 0) { end = part; break }
      }
      if (end !== undefined) { index = end; continue }
    }
    measurements.push(value)
  }
  return measurements
}

function readPrescriptions(cell: string, actual = false): Performance[] {
  const segments = unescapeSheetsExportCell(cell).split(sheetsSetSeparator)
  const values = actual ? withoutSkips(segments) : segments
  const notation = values.join(sheetsSetSeparator)
  if (!notation.trim()) return []

  // A blank segment cannot be an exported set. Keep the full notation in that case.
  if (values.some(value => !value.trim())) return [{ kind: 'freeform', value: notation }]

  return values.map(value => {
    const target = performanceSchema.safeParse(readCompactTarget(value))
    return target.success && formatCompactSet(target.data) === value ? target.data : { kind: 'freeform', value }
  })
}

/** Parse one copied workout for preview. Throws on invalid selections. */
export function parseSheetsWorkout(tsv: string): SheetsWorkout {
  let firstRow = true
  let workout: SheetsWorkout | undefined
  let firstExerciseLine = 0

  for (const { line, cells } of readRows(tsv.replace(/^\uFEFF/u, ''))) {
    if (cells.every(cell => !cell.trim())) continue

    if (cells.length !== sheetsHeaders.length) {
      throw new Error(`Line ${line} has ${cells.length} columns. Copy all ${sheetsHeaders.length} columns from the CURRENT WEEK marker through Coach Notes, including blank cells.`)
    }

    const [marker, date, day, exercise, target, actual, , , , notes] = cells
    if (marker === sheetsHeaders[0]) {
      if (!firstRow || !sheetsHeaders.every((header, index) => cells[index] === header)) {
        throw new Error(`Line ${line} has an unexpected header. Use the Workout Companion export headers once, above the workout rows.`)
      }
      firstRow = false
      continue
    }
    firstRow = false

    if (marker !== sheetsWeekMarker) throw new Error(`Line ${line} must start with the CURRENT WEEK marker. Include the first column when copying.`)
    try { assertDate(date) }
    catch { throw new Error(`Line ${line} needs a valid Date in YYYY-MM-DD format.`) }
    if (!day.trim()) throw new Error(`Line ${line} is missing a Day. Fill in the scheduled day for this exercise.`)
    const name = unescapeSheetsExportCell(exercise)
    if (!name.trim()) throw new Error(`Line ${line} is missing an Exercise name. Fill it in or exclude the row.`)

    if (!workout) {
      workout = { date, day, exercises: [] }
      firstExerciseLine = line
    } else if (date !== workout.date || day !== workout.day) {
      throw new Error(`Lines ${firstExerciseLine} and ${line} have different workout days (${workout.date} ${workout.day} and ${date} ${day}). Copy rows for one Date and Day at a time.`)
    }

    const coachNotes = unescapeSheetsExportCell(notes)
    workout.exercises.push({
      name,
      targets: readPrescriptions(target),
      actuals: readPrescriptions(actual, true),
      ...(coachNotes.trim() && { coachNotes }),
    })
  }

  if (!workout) throw new Error('No exercises found. Copy at least one workout row from Google Sheets.')
  return workout
}
