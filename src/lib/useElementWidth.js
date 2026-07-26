import { useEffect, useRef, useState } from 'react'

// Measure an element's width so children can lay out against real space rather
// than an assumed viewport. The commit rail is SVG with absolute coordinates,
// so it cannot reflow with CSS — it has to be told how much room it has.
export function useElementWidth() {
  const ref = useRef(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width)
    })
    observer.observe(el)
    setWidth(el.getBoundingClientRect().width)
    return () => observer.disconnect()
  }, [])

  return [ref, width]
}
