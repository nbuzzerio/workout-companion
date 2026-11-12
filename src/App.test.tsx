import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import App from './App'
import { SessionStore } from './storage'
import { type Session } from './workouts'
afterEach(() => { cleanup(); vi.restoreAllMocks() })
function memoryStore() {
  const store = new SessionStore()
  const rows: Session[] = []
  vi.spyOn(store, 'ensurePlan').mockResolvedValue(undefined)
  vi.spyOn(store, 'list').mockImplementation(async () => structuredClone(rows))
  vi.spyOn(store, 'save').mockImplementation(async s => { const saved = { ...structuredClone(s), revision: s.revision + 1 }; const i = rows.findIndex(r => r.id === s.id); if (i < 0) rows.push(saved); else rows[i] = saved; return saved })
  return store
}
test('explicit confirmation and recoverable denied writes never report success', async () => {
  const store = memoryStore()
  const save = vi.spyOn(store, 'save').mockRejectedValue(new Error('denied'))
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  render(<App store={store} />)
  await screen.findByText('No saved sessions for this date.')
  fireEvent.click(screen.getByRole('button', { name: 'Start DEMO session' }))
  expect(screen.getByLabelText('Leg Extension set 1 machine position')).toBeDefined()
  expect(screen.getByLabelText('DB Deadlift set 1 pounds')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Save session' }))
  expect(save).not.toHaveBeenCalled()
  confirm.mockReturnValue(true)
  fireEvent.click(screen.getByRole('button', { name: 'Save session' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Save failed'))
  expect(screen.getByRole('status').textContent).not.toContain('Saved on this device')
  expect(screen.getByLabelText('Leg Extension set 1 machine position').getAttribute('value')).toBe('P9')
})
test('component save, remount, reopen and accessible field labels using injected storage', async () => {
  const store = memoryStore()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  const first = render(<App store={store} />)
  await screen.findByText('No saved sessions for this date.')
  fireEvent.click(screen.getByRole('button', { name: 'Start DEMO session' }))
  fireEvent.change(screen.getByLabelText('DB Deadlift set 1 pounds'), { target: { value: '48' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save session' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved on this device.'))
  first.unmount()
  render(<App store={store} />)
  fireEvent.click(await screen.findByRole('button', { name: /DEMO .*active/ }))
  expect((screen.getByLabelText('DB Deadlift set 1 pounds') as HTMLInputElement).value).toBe('48')
  expect(screen.getByRole('region', { name: 'Current session' })).toBeDefined()
})
