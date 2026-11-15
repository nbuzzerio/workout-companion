import { vi } from 'vitest'

// Service workers require a real browser. Keep jsdom focused on runner behavior;
// production registration, scope and offline navigation are exercised by e2e.
vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({ needRefresh: [false], offlineReady: [false], updateServiceWorker: vi.fn() }),
}))
