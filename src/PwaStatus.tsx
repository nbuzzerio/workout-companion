import { useRegisterSW } from 'virtual:pwa-register/react'

// Applying a waiting worker reloads the page. The runner owns the save guard,
// including partially entered actuals that are still part of a local draft.
export function PwaStatus({ canReload }: { canReload: boolean }) {
  const { needRefresh: [needRefresh], offlineReady: [offlineReady], updateServiceWorker } = useRegisterSW()
  if (needRefresh) return <aside className="demo" aria-label="App update">
    <span>{canReload ? 'An app update is ready.' : 'An app update is ready. Save or discard your changes before updating.'}</span>
    <button disabled={!canReload} onClick={() => void updateServiceWorker(true)}>Reload to update</button>
  </aside>
  if (offlineReady) return <p className="measurement-note">Ready for offline use on this device.</p>
  return null
}
