import { useEffect, useId, useRef } from 'react'

export type RequestConfirmation = (message: string, onConfirm: () => void) => void

export function ConfirmationDialog({ message, onConfirm, onDismiss }: {
  message: string
  onConfirm: () => void
  onDismiss: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useId()
  useEffect(() => { dialog.current?.showModal() }, [])

  function dismiss() {
    dialog.current?.close()
    onDismiss()
  }

  return <dialog ref={dialog} className="confirmation-dialog" aria-labelledby={title} onCancel={event => {
    event.preventDefault()
    dismiss()
  }}>
    <h2 id={title}>{message}</h2>
    <div className="actions">
      <button type="button" onClick={dismiss}>Cancel</button>
      <button type="button" className="primary" onClick={() => { dismiss(); onConfirm() }}>OK</button>
    </div>
  </dialog>
}
