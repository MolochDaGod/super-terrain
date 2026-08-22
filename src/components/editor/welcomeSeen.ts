/**
 * Whether the introduction has already been shown on this machine.
 *
 * Kept out of the component file so the dialog module exports components only,
 * which is what keeps fast refresh working for it.
 */
const SEEN_KEY = 'meshterrain.welcome-seen'

export function hasSeenWelcome(): boolean {
  if (typeof localStorage === 'undefined') return true
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return true
  }
}

export function rememberWelcome(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
    // Showing it twice is a much smaller problem than failing to open.
  }
}
