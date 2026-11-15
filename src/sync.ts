import type { Plan, Session } from './workouts'

// Future type boundary only. No adapter, requests, outbox, or schema changes.
// Envelopes distinguish existing plan and session IDs without rewriting them.
export type SyncRecord = { kind: 'plan'; value: Plan } | { kind: 'session'; value: Session }
export interface SyncAdapter {
  exchange(request: {
    appId: 'workout'
    deviceId: string
    cursor: string | null
    changes: { operationId: string; baseServerVersion: string | null; record: SyncRecord }[]
  }): Promise<{
    cursor: string
    acceptedOperationIds: string[]
    changes: { record: SyncRecord; serverVersion: string }[]
    conflicts: { operationId: string; current: SyncRecord; serverVersion: string }[]
  }>
}
