import { SyncApi, ApiError } from './sync-api'
import { SyncStore } from './sync-store'
import type { ExchangeRequest } from './sync'
import type { StorageNotice } from './database'

const pollInterval = 60_000
export type Coordinator = <T>(work: () => Promise<T>, wait?: boolean) => Promise<T | undefined>
export const browserCoordinator: Coordinator = async (work, wait = false) => {
  if (!navigator.locks) throw new Error('This browser needs Web Locks for safe synchronization. Local workouts still work; use a current browser.')
  const name = 'workout-sync-v1'
  if (!wait) return navigator.locks.request(name, { ifAvailable: true }, lock => lock ? work() : undefined)
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(new Error('Another tab is still syncing. Your saved changes will retry automatically.')), 20_000)
  try {
    return await navigator.locks.request(name, { signal: controller.signal }, () => {
      clearTimeout(deadline)
      return work()
    })
  } finally { clearTimeout(deadline) }
}
export class SyncEngine {
  private running?: Promise<void>
  private stopped = false
  private timer?: ReturnType<typeof setTimeout>
  private wakeRequested = false
  private schedule?: (poll?: boolean) => void
  private activity?: (active: boolean) => void
  private onError?: (error: Error) => void
  readonly store: SyncStore; readonly api: SyncApi; private coordinate: Coordinator
  constructor(store: SyncStore, api = new SyncApi(), coordinate: Coordinator = browserCoordinator) { this.store = store; this.api = api; this.coordinate = coordinate }
  async run(force = false, poll = false): Promise<void> {
    if (this.stopped) return
    if (this.running) {
      await this.running
      if (force && !this.stopped) await this.run(true)
      return
    }
    clearTimeout(this.timer)
    this.running = this.exchange(force, poll)
    try {
      await this.running
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error('Could not check synchronization.'))
      throw error
    } finally {
      this.running = undefined
      this.activity?.(false)
      this.schedule?.(!this.wakeRequested)
      this.wakeRequested = false
    }
  }
  private async exchange(force: boolean, poll: boolean) {
    if (!force && typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (navigator.onLine === false || !(await this.store.settings()).enabled) return
    if (force) this.activity?.(true)
    await this.coordinate(async () => {
      let s = await this.store.settings()
      if (this.stopped || !s.enabled || !s.spaceId || navigator.onLine === false) return
      if (!force && (s.nextRetry > Date.now() || (poll && s.signInRequired))) return
      // Staggered tab timers share the persisted confirmation time under the lock.
      if (poll && !s.error && s.catchUpPending === false && s.lastSuccess && Date.now() - Date.parse(s.lastSuccess) < pollInterval) return
      if (s.phase !== 'ready' && s.stageComplete && !s.signInRequired) return
      if (!force) this.activity?.(true)
      const controlVersion = s.controlVersion ?? 0
      const active = async () => { s = await this.store.settings(); return s.enabled && !this.stopped && (s.controlVersion ?? 0) === controlVersion }
      try {
        if (!this.api.session) await this.api.restore()
        if (this.api.session!.principalId !== s.principalId) throw new Error('Signed in as a different owner. Local records retained; reconnect with the original owner.')
        // Both streams are bounded per pass; continuation is durable across exits.
        let commonPending = true
        for (let i = 0; i < 8; i++) {
          if (!await active()) return
          try { const common = await this.api.common(s.commonCursor); await this.store.common(common, controlVersion); commonPending = common.hasMore; if (!commonPending) break }
          catch (e) { if (!await active()) return; if (e instanceof ApiError && e.code === 'CURSOR_RESET_REQUIRED') { await this.store.patch({ commonCursor: null }, controlVersion); continue } throw e }
        }
        for (let i = 0; i < 12; i++) {
          if (!await active() || !s.spaceId) return
          if (s.phase !== 'ready' && s.stageComplete) {
            if (s.signInRequired) await this.store.patch({ signInRequired: false, error: undefined }, controlVersion)
            return
          }
          const staging = s.phase === 'initial' || s.phase === 'recovery'
          const changes = staging ? [] : await this.store.batch()
          // Batch preparation is asynchronous. Pause may commit in another tab
          // while it runs; recheck before dispatching another network request.
          if (!await active() || !s.spaceId) return
          const request: ExchangeRequest = { protocolVersion: 1, appId: 'workout', deviceId: s.deviceId, spaceId: s.spaceId, cursor: staging ? s.stageCursor ?? null : s.cursor, limit: 25, changes }
          try {
            const response = await this.api.exchange(request)
            if (staging) await this.store.stage(response, controlVersion)
            else await this.store.apply(response, changes, s.spaceId, controlVersion, commonPending)
            // A second catch-up with no writes closes a page ceiling that may
            // predate acknowledged writes. Never infer download progress from ACKs.
            if (!response.hasMore && (staging || changes.length === 0)) return
          } catch (e) {
            if (!await active()) return
            if (e instanceof ApiError && e.code === 'CURSOR_RESET_REQUIRED') { await this.store.startRecovery(controlVersion); continue }
            throw e
          }
        }
      } catch (error) {
        if (!await active()) return
        const failures = Math.min(s.failures + 1, 10)
        const delay = Math.max(Math.min(300_000, 2000 * 2 ** failures), error instanceof ApiError ? error.retryAfter : 0)
        // A different tab can rotate the cookie. A CSRF rejection clears the
        // in-memory token in SyncApi so the next pass can restore that session.
        const signInRequired = error instanceof ApiError && error.status === 401
        await this.store.patch({ failures, signInRequired, nextRetry: Date.now() + delay, error: error instanceof Error ? error.message : 'Service unavailable. Changes remain saved on this device.' }, controlVersion)
      }
    }, force)
  }
  start(activity?: (active: boolean) => void, onError?: (error: Error) => void) {
    this.stopped = false
    this.activity = activity
    this.onError = onError
    const schedule = (poll = false) => {
      if (this.stopped) return
      if (this.running) { this.wakeRequested = true; return }
      clearTimeout(this.timer)
      this.timer = setTimeout(() => { void this.run(false, poll).catch(() => { /* reported by run */ }) }, poll ? pollInterval : 1500)
    }
    this.schedule = schedule
    const notice = (value: StorageNotice | undefined) => {
      if (value?.type === 'local' || (value?.type === 'control' && value.enabled)) schedule()
      else if (value?.type === 'control') { clearTimeout(this.timer); this.timer = undefined; this.wakeRequested = false; this.api.abort() }
      // Cursor/ACK/directory/retry writes refresh views only, never wake sync.
    }
    const changed = (event: Event) => notice((event as CustomEvent<StorageNotice>).detail)
    const foreground = () => { if (document.visibilityState === 'visible') schedule() }
    const wake = () => schedule()
    window.addEventListener('online', wake); window.addEventListener('focus', foreground)
    window.addEventListener('workout-storage', changed); document.addEventListener('visibilitychange', foreground)
    const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('workout-storage'); if (channel) channel.onmessage = event => notice(event.data)
    schedule()
    return () => {
      this.stopped = true; this.schedule = undefined; this.activity = undefined; this.onError = undefined; this.wakeRequested = false
      clearTimeout(this.timer); this.api.cancel(); channel?.close()
      window.removeEventListener('online', wake); window.removeEventListener('focus', foreground)
      window.removeEventListener('workout-storage', changed); document.removeEventListener('visibilitychange', foreground)
    }
  }
  async pause() { await this.store.patch({ enabled: false }); this.api.abort() }
}
