import { useId, useState } from 'react'
import { sheetsHeaders, sheetsRows, sheetsTsv } from './sheets-export'
import type { Session } from './workouts'

interface Props {
  session: Session
  day: string
}

export function GoogleSheetsExport({ session, day }: Props) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return <div className="sheets-export">
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      Export to Google Sheets
    </button>
    <div id={id} hidden={!open}>{open && <SheetsPreview session={session} day={day} />}</div>
  </div>
}

type CopyFeedback =
  | { state: 'copying' }
  | { state: 'copied'; withHeaders: boolean }
  | { state: 'failed'; tsv: string }

function SheetsPreview({ session, day }: Props) {
  const [feedback, setFeedback] = useState<CopyFeedback>()
  const heading = useId()
  const rows = sheetsRows(session, day)
  const copying = feedback?.state === 'copying'

  async function copy(withHeaders: boolean) {
    const tsv = sheetsTsv(withHeaders ? [sheetsHeaders, ...rows] : rows)
    setFeedback({ state: 'copying' })
    try {
      await navigator.clipboard.writeText(tsv)
      setFeedback({ state: 'copied', withHeaders })
    } catch {
      setFeedback({ state: 'failed', tsv })
    }
  }

  return <section className="sheets-preview" aria-labelledby={heading}>
    <h3 id={heading}>Google Sheets preview</h3>
    <p>Use Copy Rows to paste below your existing spreadsheet headers.</p>
    <div className="actions">
      <button type="button" className="primary" disabled={copying || rows.length === 0} onClick={() => void copy(false)}>Copy Rows</button>
      <button type="button" disabled={copying} onClick={() => void copy(true)}>Copy With Headers</button>
    </div>
    <div role="status">
      {copying && 'Copying to clipboard…'}
      {feedback?.state === 'copied' && (feedback.withHeaders ? 'Rows and headers copied.' : 'Rows copied.')}
    </div>
    {feedback?.state === 'failed' && <>
      <p role="alert">Could not copy to the clipboard. Select and copy the TSV below.</p>
      <label>TSV to copy manually<textarea readOnly rows={4} value={feedback.tsv} onFocus={event => event.currentTarget.select()} /></label>
    </>}
    {rows.length === 0 && <p>No exercises to export.</p>}
    <div className="sheets-table" role="region" aria-label="Export columns and rows" tabIndex={0}>
      <table aria-labelledby={heading}>
        <thead><tr>{sheetsHeaders.map(header => <th key={header} scope="col">{header}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index}>
          {row.map((value, column) => <td key={column}>{value}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
  </section>
}
