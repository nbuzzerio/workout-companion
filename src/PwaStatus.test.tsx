import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import App from './App'
import { PwaStatus } from './PwaStatus'
import { SessionStore } from './storage'

const worker = vi.hoisted(() => ({ update: vi.fn(), waiting: true, offline: false }))
vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({ needRefresh: [worker.waiting], offlineReady: [worker.offline], updateServiceWorker: worker.update }),
}))
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); worker.waiting = true; worker.offline = false })

test('a waiting worker only activates after an explicit allowed update', () => {
  const view = render(<PwaStatus canReload={false} />)
  const button = screen.getByRole('button', { name: 'Reload to update' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(worker.update).not.toHaveBeenCalled()
  view.rerender(<PwaStatus canReload />)
  fireEvent.click(button)
  expect(worker.update).toHaveBeenCalledWith(true)
})

test('the runner prevents an update while dirty, including partial machine input', async () => {
  const store = new SessionStore()
  vi.spyOn(store, 'ensurePlan').mockResolvedValue(undefined)
  vi.spyOn(store, 'list').mockResolvedValue([])
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  render(<App store={store} />)
  const update = screen.getByRole('button', { name: 'Reload to update' }) as HTMLButtonElement
  await waitFor(() => expect(update.disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Start Workout' }))
  fireEvent.change(screen.getByLabelText('Leg Extension set 1 machine position'), { target: { value: 'P' } })
  expect(update.disabled).toBe(true)
  fireEvent.click(update)
  expect(worker.update).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved changes' }))
  expect(update.disabled).toBe(false)
})

test('offline readiness is reported without automatically activating an update', () => {
  worker.waiting = false
  worker.offline = true
  render(<PwaStatus canReload />)
  expect(screen.getByText('Ready for offline use on this device.')).toBeDefined()
  expect(worker.update).not.toHaveBeenCalled()
})
