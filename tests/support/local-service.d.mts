export const password: string
export interface Fixture {
  url: string; owner: string; dir: string; path: string
  db: { prepare(sql: string): { run(...values: unknown[]): unknown; all(...values: unknown[]): unknown[]; get(...values: unknown[]): unknown } }
  space(name?: string): import('../../src/sync').Space
  person(name?: string): import('../../src/sync').Person
  exchange(spaceId: string, changes?: unknown[], extra?: Record<string, unknown>): unknown
  backup(): Promise<string>
  restore(source: string): Promise<void>
  close(): Promise<void>
  clientFetch(): typeof fetch
}
export function fixture(origin?: string, port?: number): Promise<Fixture>
