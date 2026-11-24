import { useId } from 'react'
import { ExerciseFeedbackSummary } from './ExerciseFeedback'
import { previousSetChange, recentExerciseResults, type ExerciseReference } from './exercise-progression'
import { formatSet, type Session } from './workouts'

interface Props {
  history: readonly Session[]
  exercises: readonly ExerciseReference[]
  exerciseIndex: number
  setIndex?: number
}

export function ExerciseProgression({ history, exercises, exerciseIndex, setIndex }: Props) {
  const lastSetId = useId()
  const { name } = exercises[exerciseIndex]
  if (!name.trim()) return null
  const results = recentExerciseResults(history, exercises, exerciseIndex)
  if (!results.length) return <p className="progression-caption">No earlier recorded results.</p>

  const latest = setIndex === undefined ? undefined : results.find(result => result.sets.some(set => set.index === setIndex))
  const latestSet = latest?.sets.find(set => set.index === setIndex)
  const showLastSet = latest && latestSet && latestSet.actual.kind !== 'freeform'

  return <details className="exercise-progression">
    <summary aria-label={`Recent performance for ${name.trim()}`} aria-describedby={showLastSet ? lastSetId : undefined}>
      Recent performance
      {showLastSet && <small id={lastSetId} className="progression-caption">
        Last recorded set {latestSet.index + 1} · {formatSet(latestSet.actual)} · <time dateTime={latest.date}>{latest.date}</time>
      </small>}
    </summary>
    <ol className="progression-results" role="list" aria-label="Earlier saved workouts">
      {results.map(result => <li key={result.sessionId}>
        <strong><time dateTime={result.date}>{result.date}</time></strong>
        {result.status === 'active' && <small className="progression-caption">In progress</small>}
        {result.sets.length ? <>
          <p className="progression-caption">Recorded performance</p>
          <dl className="progression-sets">{result.sets.map(set => {
            const comparison = previousSetChange(results, result, set)
            return <div key={set.index}>
              <dt>Set {set.index + 1}</dt>
              <dd>{formatSet(set.actual)}
                {comparison && <small className="progression-caption">Since {comparison.date} · {comparison.change}</small>}
              </dd>
            </div>
          })}</dl>
        </> : <p className="progression-caption">No sets recorded</p>}
        <ExerciseFeedbackSummary feedback={result.feedback} />
      </li>)}
    </ol>
  </details>
}
