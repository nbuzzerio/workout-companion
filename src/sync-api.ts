import { z } from 'zod'
import { commonSchema, exchangeSchema, personSchema, spaceSchema, type ExchangeRequest, type Space, type Person } from './sync'

const sessionSchema = z.object({ principalId: z.uuid(), csrfToken: z.string().min(1), expiresAt: z.number().int() })
export class ApiError extends Error {
  status: number; code: string; retryAfter: number
  constructor(status: number, code: string, retryAfter = 0) { super(code === 'INVALID_CREDENTIALS' ? 'Incorrect household password.' : code === 'UNAUTHENTICATED' ? 'Authentication expired. Sign in again; pending changes are safe.' : `Sync service: ${code}`); this.status = status; this.code = code; this.retryAfter = retryAfter }
}
export class SyncApi {
  session: z.infer<typeof sessionSchema> | null = null
  private passwordRequired = false
  private restoring?: Promise<z.infer<typeof sessionSchema>>
  get authState(): 'signed-in' | 'signed-out' | 'unknown' {
    if (this.session) return 'signed-in'
    return this.passwordRequired ? 'signed-out' : 'unknown'
  }
  private controllers = new Map<AbortController, string>()
  private readonly request: typeof fetch
  constructor(request: typeof fetch = (...args) => fetch(...args)) { this.request = request }
  abortSync() {
    // A pause notification can arrive after logout has started in this tab.
    for (const [controller, path] of this.controllers) if (!path.startsWith('/auth/')) controller.abort()
  }
  cancel() {
    this.restoring = undefined
    for (const controller of this.controllers.keys()) controller.abort()
    this.session = null
  }
  async call(path: string, body?: unknown): Promise<unknown> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid API path')
    const sentSession = this.session
    const controller = new AbortController(); this.controllers.set(controller, path)
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const response = await this.request(`/api/v1${path}`, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(this.session ? { 'X-CSRF-Token': this.session.csrfToken } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) {
        const error = await response.json().catch(() => null) as { error?: { code?: string } } | null
        controller.signal.throwIfAborted()
        if (this.session === sentSession && (response.status === 401 || error?.error?.code === 'CSRF_REQUIRED')) {
          this.session = null
          this.passwordRequired = response.status === 401
        }
        const retry = response.headers.get('Retry-After')
        throw new ApiError(response.status, error?.error?.code ?? `HTTP_${response.status}`, retry ? Math.max(0, Number(retry) * 1000 || Date.parse(retry) - Date.now()) : 0)
      }
      const value = response.status === 204 ? undefined : await response.json()
      controller.signal.throwIfAborted()
      return value
    } finally { clearTimeout(timer); this.controllers.delete(controller) }
  }
  async login(password: string) {
    this.session = sessionSchema.parse(await this.call('/auth/household-login', { password }))
    this.restoring = undefined
    this.passwordRequired = false
    return this.session
  }
  restore() {
    if (!this.restoring) {
      const pending = this.call('/auth/session').then(value => {
        if (this.restoring !== pending) throw new DOMException('Session check superseded', 'AbortError')
        this.session = sessionSchema.parse(value)
        this.passwordRequired = false
        return this.session
      }).finally(() => { if (this.restoring === pending) this.restoring = undefined })
      this.restoring = pending
    }
    return this.restoring
  }
  async logout() {
    if (!this.session) await this.restore()
    await this.call('/auth/logout', {})
    this.cancel()
    this.passwordRequired = true
  }
  async exchange(request: ExchangeRequest) { return exchangeSchema.parse(await this.call('/apps/workout/exchange', request)) }
  async common(cursor: string | null) { return commonSchema.parse(await this.call('/common/changes', { protocolVersion: 1, cursor, limit: 50 })) }
  async directory(kind: 'people'): Promise<Person[]>
  async directory(kind: 'spaces'): Promise<Space[]>
  async directory(kind: 'people' | 'spaces'): Promise<(Person | Space)[]> {
    const items: (Person | Space)[] = []; let after: string | null = null
    do {
      const page: { items: (Person | Space)[]; hasMore: boolean; after: string | null } = z.object({ items: z.array(kind === 'people' ? personSchema : spaceSchema), hasMore: z.boolean(), after: z.string().nullable() }).parse(await this.call(`/${kind}?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`))
      if (page.hasMore && page.after === after) throw new Error('Directory cursor did not advance')
      items.push(...page.items); after = page.hasMore ? page.after : null
      if (page.hasMore && !after) throw new Error('Invalid directory pagination')
    } while (after)
    return items
  }
  async createSpace(id: string, name: string) {
    try { return spaceSchema.parse(await this.call('/spaces', { id, name, kind: 'personal' })) }
    catch (e) { if (e instanceof ApiError && e.code === 'ID_EXISTS') return spaceSchema.parse(await this.call(`/spaces/${encodeURIComponent(id)}`)); throw e }
  }
  async createPerson(id: string, displayName: string) {
    try { return personSchema.parse(await this.call('/people', { id, displayName })) }
    catch (e) { if (e instanceof ApiError && e.code === 'ID_EXISTS') return personSchema.parse(await this.call(`/people/${encodeURIComponent(id)}`)); throw e }
  }
}
