import { SyncApi, ApiError } from './sync-api'
import { SyncStore } from './sync-store'
import type { ExchangeRequest } from './sync'
import type { StorageNotice } from './database'

export type Coordinator = <T>(work: () => Promise<T>) => Promise<T | undefined>
export const browserCoordinator: Coordinator = async work => {
  if (!navigator.locks) throw new Error('This browser needs Web Locks for safe synchronization. Local workouts still work; use a current browser.')
  return navigator.locks.request('workout-sync-v1', { ifAvailable: true }, lock => lock ? work() : undefined)
}
export class SyncEngine {
  private running = false
  private stopped = false
  private timer?: ReturnType<typeof setTimeout>
  private wakeRequested = false
  private wake?: () => void
  readonly store: SyncStore; readonly api: SyncApi; private coordinate: Coordinator
  constructor(store: SyncStore, api = new SyncApi(), coordinate: Coordinator = browserCoordinator) { this.store = store; this.api = api; this.coordinate = coordinate }
  async run(force = false) {
    if (this.running || this.stopped) return
    if (!force && typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    this.running = true
    try {
      if (!(await this.store.settings()).enabled) return
      await this.coordinate(async () => {
        let s = await this.store.settings()
        if (!s.enabled || !s.spaceId || (!force && s.nextRetry > Date.now()) || navigator.onLine === false) return
        const controlVersion = s.controlVersion ?? 0
        const active = async () => { s = await this.store.settings(); return s.enabled && !this.stopped && (s.controlVersion ?? 0) === controlVersion }
        try {
          if (!this.api.session) await this.api.restore()
          if (this.api.session!.principalId !== s.principalId) throw new Error('Signed in as a different owner. Local records retained; reconnect with the original owner.')
          // Both streams are bounded per pass; continuation is durable across exits.
          for (let i = 0; i < 8; i++) {
            if (!await active()) return
            try { const common = await this.api.common(s.commonCursor); await this.store.common(common, controlVersion); if (!common.hasMore) break }
            catch (e) { if (!await active()) return; if (e instanceof ApiError && e.code === 'CURSOR_RESET_REQUIRED') { await this.store.patch({ commonCursor: null }); continue } throw e }
          }
          for (let i = 0; i < 12; i++) {
            if (!await active() || !s.spaceId) return
            if (s.phase !== 'ready' && s.stageComplete) return
            const staging = s.phase === 'initial' || s.phase === 'recovery'
            const changes = staging ? [] : await this.store.batch()
            // Batch preparation is asynchronous. Pause may commit in another tab
            // while it runs; recheck before dispatching another network request.
            if (!await active() || !s.spaceId) return
            const request: ExchangeRequest = { protocolVersion: 1, appId: 'workout', deviceId: s.deviceId, spaceId: s.spaceId, cursor: staging ? s.stageCursor ?? null : s.cursor, limit: 25, changes }
            try {
              const response = await this.api.exchange(request)
              if (staging) await this.store.stage(response, controlVersion)
              else await this.store.apply(response, changes, s.spaceId, controlVersion)
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
          await this.store.patch({ failures, nextRetry: Date.now() + delay, error: error instanceof Error ? error.message : 'Service unavailable. Changes remain saved on this device.' })
        }
      })
    } finally { this.running = false; if (this.wakeRequested) { this.wakeRequested = false; this.wake?.() } }
  }
  start() {
    this.stopped = false
    const schedule = () => {
      if (this.stopped) return
      if (this.running) { this.wakeRequested = true; return }
      clearTimeout(this.timer); this.timer = setTimeout(() => { this.timer = undefined; void this.run().catch(() => {}).finally(() => { if (!this.stopped && this.timer === undefined) { this.timer = setTimeout(() => { this.timer = undefined; schedule() }, 60_000) } }) }, 1500)
    }
    this.wake = schedule
    const notice = (value: StorageNotice | undefined) => {
      if (value?.type === 'local' || (value?.type === 'control' && value.enabled)) schedule()
      else if (value?.type === 'control') { clearTimeout(this.timer); this.timer = undefined; this.wakeRequested = false; this.api.abort() }
      // Cursor/ACK/directory/retry writes refresh views only, never wake sync.
    }
    const changed = (event: Event) => notice((event as CustomEvent<StorageNotice>).detail)
    const foreground = () => { if (document.visibilityState === 'visible') schedule() }
    window.addEventListener('online', schedule); window.addEventListener('workout-storage', changed); document.addEventListener('visibilitychange', foreground)
    const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('workout-storage'); if (channel) channel.onmessage = event => notice(event.data)
    schedule()
    return () => { this.stopped = true; this.wake = undefined; this.wakeRequested = false; clearTimeout(this.timer); this.api.cancel(); channel?.close(); window.removeEventListener('online', schedule); window.removeEventListener('workout-storage', changed); document.removeEventListener('visibilitychange', foreground) }
  }
  async pause() { await this.store.patch({ enabled: false }); this.api.abort() }
}
