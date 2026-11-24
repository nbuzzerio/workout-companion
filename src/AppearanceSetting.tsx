import { useState } from 'react'

type Appearance = 'system' | 'light' | 'dark'
// The script in index.html reads this key before the first paint.
const appearanceKey = 'workout-companion-appearance'

export function AppearanceSetting() {
  const [appearance, setAppearance] = useState<Appearance>(() => {
    const preference = document.documentElement.dataset.appearance
    return preference === 'light' || preference === 'dark' ? preference : 'system'
  })
  const [saveFailed, setSaveFailed] = useState(false)

  function changeAppearance(preference: Appearance) {
    const root = document.documentElement
    const colorScheme = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')
    setAppearance(preference)
    if (preference === 'system') delete root.dataset.appearance
    else root.dataset.appearance = preference
    if (colorScheme) colorScheme.content = preference === 'system' ? 'light dark' : preference

    try {
      if (preference === 'system') localStorage.removeItem(appearanceKey)
      else localStorage.setItem(appearanceKey, preference)
      setSaveFailed(false)
    } catch {
      setSaveFailed(true)
    }
  }

  return <div className="appearance-setting">
    <label>Appearance
      <select value={appearance} onChange={event => changeAppearance(event.currentTarget.value as Appearance)}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
    {saveFailed && <p role="status">Appearance could not be saved on this device.</p>}
  </div>
}
