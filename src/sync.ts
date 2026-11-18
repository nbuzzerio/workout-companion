import { z } from 'zod'
import type { Plan, Session } from './workouts'

export type Kind = 'plan' | 'session'
export type Value = Plan | Session
export type Association = { personId: string; role: string }
export type Operation = { operationId: string; kind: Kind; recordId: string; baseServerVersion: string | null } & (
  { type: 'put'; schemaVersion: 1; value: Value; people: Association[]; resurrect: boolean } | { type: 'delete' })
const version = z.string().regex(/^[1-9][0-9]{0,14}$/)
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/)
const numeric = z.number().finite().nonnegative()
const performance = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('weight'), pounds: numeric, reps: numeric.int() }).passthrough(),
  z.object({ kind: z.literal('machine'), position: z.string().regex(/^P\d+$/), reps: numeric.int() }).passthrough(),
  z.object({ kind: z.literal('hold'), seconds: numeric }).passthrough(),
])
const exercises = z.array(z.object({ id, name: z.string().min(1), sets: z.array(performance).max(100), musclesSource: z.string().optional() }).passthrough()).max(200)
export const planSchema = z.object({ version: z.literal(1), id, name: z.string().min(1), weekday: z.number().int().min(0).max(6), demo: z.boolean(), exercises }).passthrough()
export const sessionSchema = z.object({ version: z.literal(1), id, planId: id, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(`${v}T12:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v }), demo: z.boolean(), revision: numeric.int().safe(), status: z.enum(['active', 'completed']), exercises }).passthrough()
export const associationsSchema = z.array(z.object({ personId: z.uuid(), role: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/) }).strict()).max(64)
export const snapshotSchema = z.object({ kind: z.enum(['plan', 'session']), recordId: id, schemaVersion: z.literal(1), value: z.unknown(), people: associationsSchema, deleted: z.boolean(), serverVersion: version, createdAt: z.string(), updatedAt: z.string(), updatedBy: z.uuid(), deviceId: z.uuid() }).strict().superRefine((s, ctx) => {
  if (s.deleted ? s.value !== null : !(s.kind === 'plan' ? planSchema : sessionSchema).safeParse(s.value).success || (s.value as Value)?.id !== s.recordId) ctx.addIssue({ code: 'custom', message: 'Unsupported downloaded record; local data retained.' })
})
export type Snapshot = Omit<z.infer<typeof snapshotSchema>, 'value'> & { value: Value | null }
const resultSchema = z.discriminatedUnion('status', [
  z.object({ operationId: z.uuid(), status: z.literal('accepted'), serverVersion: version }).strict(),
  z.object({ operationId: z.uuid().nullable(), status: z.literal('rejected'), code: z.string() }).strict(),
  z.object({ operationId: z.uuid(), status: z.literal('conflict'), code: z.literal('VERSION_CONFLICT'), current: snapshotSchema.nullable(), serverVersion: version.nullable() }).strict(),
])
export const exchangeSchema = z.object({ protocolVersion: z.literal(1), results: z.array(resultSchema), acceptedOperationIds: z.array(z.uuid()), rejected: z.array(resultSchema), conflicts: z.array(resultSchema), changes: z.array(snapshotSchema), cursor: z.string().min(1), hasMore: z.boolean() }).strict()
export type ExchangeResponse = z.infer<typeof exchangeSchema>
export type ExchangeRequest = { protocolVersion: 1; appId: 'workout'; deviceId: string; spaceId: string; cursor: string | null; limit: number; changes: Operation[] }
export interface Person { id: string; displayName: string; archived: boolean; serverVersion: string }
export interface Space { id: string; name: string; kind: 'personal' | 'shared'; archived: boolean; serverVersion: string }
export const personSchema = z.object({ id: z.uuid(), displayName: z.string(), archived: z.boolean(), serverVersion: version }).passthrough()
export const spaceSchema = z.object({ id: z.uuid(), name: z.string(), kind: z.enum(['personal', 'shared']), archived: z.boolean(), serverVersion: version }).passthrough()
export const commonSchema = z.object({ protocolVersion: z.literal(1), cursor: z.string().min(1), hasMore: z.boolean(), changes: z.array(z.discriminatedUnion('entityType', [z.object({ entityType: z.literal('person'), value: personSchema }), z.object({ entityType: z.literal('space'), value: spaceSchema }), z.object({ entityType: z.literal('membership'), value: z.object({ spaceId: z.uuid(), personId: z.uuid() }).passthrough() })])) })
export function keyOf(kind: Kind, id: string) { return `${kind}:${id}` }
export function same(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v !== null && typeof v === 'object' ? `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}` : JSON.stringify(v) ?? 'null'
  return canonical(a) === canonical(b)
}
