import { vi } from 'vitest'

// Service workers require a real browser. Keep jsdom focused on runner behavior;
// production registration, scope and offline navigation are exercised by e2e.
vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({ needRefresh: [false], offlineReady: [false], updateServiceWorker: vi.fn() }),
}))

// jsdom has no modal methods. Playwright covers the browser's focus and keyboard behavior.
if (!HTMLDialogElement.prototype.showModal) {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { value(this: HTMLDialogElement) { this.open = true } },
    close: { value(this: HTMLDialogElement) { this.open = false } },
  })
}
