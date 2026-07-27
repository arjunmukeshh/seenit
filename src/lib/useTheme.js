import { useEffect, useState } from 'react'

// Theme preference: system, light or dark.
//
// Three states rather than a boolean, because "follow the OS" is a real choice
// and not the absence of one. A two-way toggle silently strands anyone who
// switches their machine to dark in the evening.
//
// Deliberately not a sun/moon switch — that control is the single most
// recognisable stamp of a generated interface, and it cannot express the third
// state anyway. This cycles through a labelled control instead.

const KEY = 'seenit:theme'
export const MODES = ['system', 'light', 'dark']

function read() {
  try {
    const stored = localStorage.getItem(KEY)
    return MODES.includes(stored) ? stored : 'system'
  } catch {
    return 'system' // private mode, or storage disabled
  }
}

export function useTheme() {
  const [mode, setMode] = useState(read)

  useEffect(() => {
    const root = document.documentElement
    // Removing the attribute hands control back to the prefers-color-scheme
    // media query rather than freezing whatever it resolved to last.
    if (mode === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', mode)

    try {
      localStorage.setItem(KEY, mode)
    } catch {
      // Not being able to persist is not a reason to fail to apply.
    }
  }, [mode])

  const cycle = () => setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length])

  return { mode, setMode, cycle }
}
