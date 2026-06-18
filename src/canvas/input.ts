// All canvas navigation input: pan + zoom, for mouse AND touch.
//
// Like renderer.ts, this is the NON-React half of the app. It attaches raw
// DOM listeners to the <canvas> and, on every gesture, writes the camera
// (`zoom` / `viewOffset`) into the store via getState(). It NEVER calls
// setState/React and never draws — the RAF loop in renderer.ts polls the
// store and repaints the next frame (CLAUDE.md rules 1-2).
//
// We use the Pointer Events API (pointerdown/move/up), not legacy mouse/touch
// events, so mouse, touch, and pen all flow through ONE code path; we branch on
// `event.pointerType` only where the gestures genuinely differ. `touch-action:
// none` on the canvas (index.css) stops the browser from hijacking drags/pinch.

import { store } from '../core/state'

// Camera limits (SPEC: zoom slider 2-40 px/block).
const MIN_ZOOM = 2
const MAX_ZOOM = 40

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * Attach all navigation listeners to `canvas`. Returns a cleanup function that
 * removes them — CanvasView calls it on unmount (StrictMode-safe, same pattern
 * as startRenderLoop).
 */
export function attachInput(canvas: HTMLCanvasElement): () => void {
  // --- Gesture state (closures, not React state) -------------------------

  // Active TOUCH/PEN pointers, keyed by pointerId, holding their latest
  // canvas-relative position. A Map (not a counter) because a pinch needs the
  // actual positions of BOTH fingers, and pointerId is how we tell them apart.
  const active = new Map<number, { x: number; y: number }>()

  // Last position for a single-pointer pan. Used for BOTH mouse right-drag and
  // one-finger touch pan; null when not panning.
  let panLast: { x: number; y: number } | null = null

  // Previous pinch state (two-finger). null when not pinching.
  let pinchPrev: { dist: number; midX: number; midY: number } | null = null

  // --- Helpers -----------------------------------------------------------

  // Pointer events report page coordinates (clientX/Y); we want pixels relative
  // to the canvas's top-left, which is what the renderer treats as screen space.
  // getBoundingClientRect handles the canvas's position AND any page scroll.
  const pos = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  // Pan by a SCREEN-pixel delta. Dragging the world right (dx > 0) should make
  // the grid coord at screen 0 decrease, so the content follows the finger:
  // viewOffset -= delta / zoom. (Divide by zoom: pixels -> grid units.)
  const pan = (dx: number, dy: number) => {
    const { zoom, viewOffset, setViewOffset } = store.getState()
    setViewOffset({ x: viewOffset.x - dx / zoom, y: viewOffset.y - dy / zoom })
  }

  // Zoom to `newZoomRaw`, keeping the grid point under (ax, ay) [screen px]
  // pinned in place. Capture the grid point under the anchor at the OLD zoom,
  // apply the new zoom, then shift viewOffset so that same grid point lands
  // back under the anchor: screenToGrid(anchor) must stay constant.
  const zoomTo = (newZoomRaw: number, ax: number, ay: number) => {
    const { zoom, viewOffset, setZoom, setViewOffset } = store.getState()
    const newZoom = clamp(newZoomRaw, MIN_ZOOM, MAX_ZOOM)
    if (newZoom === zoom) return // already clamped; nothing to do
    const gx = ax / zoom + viewOffset.x // grid point under the anchor (old zoom)
    const gy = ay / zoom + viewOffset.y
    setZoom(newZoom)
    setViewOffset({ x: gx - ax / newZoom, y: gy - ay / newZoom })
  }

  // The current two-finger distance + midpoint, from the two active pointers.
  const pinchOf = (pts: { x: number; y: number }[]) => {
    const [a, b] = pts
    return {
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
    }
  }

  // --- Pointer handlers --------------------------------------------------

  const onPointerDown = (e: PointerEvent) => {
    const p = pos(e)

    if (e.pointerType === 'mouse') {
      // Mouse pans on RIGHT button only (button 2). Left/middle are reserved
      // for future editing (add/move/delete points) and do nothing yet.
      if (e.button === 2) {
        panLast = p
        canvas.setPointerCapture(e.pointerId)
      }
      return
    }

    // Touch / pen. Capture so moves keep arriving even if the finger slides off
    // the canvas mid-drag.
    canvas.setPointerCapture(e.pointerId)
    active.set(e.pointerId, p)

    if (active.size === 1) {
      // One finger -> pan.
      panLast = p
      pinchPrev = null
    } else if (active.size === 2) {
      // Second finger down -> switch from pan to pinch.
      panLast = null
      pinchPrev = pinchOf([...active.values()])
    }
    // 3+ fingers: ignore the extras; the first two still drive the pinch.
  }

  const onPointerMove = (e: PointerEvent) => {
    const p = pos(e)

    if (e.pointerType === 'mouse') {
      if (panLast) {
        pan(p.x - panLast.x, p.y - panLast.y)
        panLast = p
      }
      return
    }

    if (!active.has(e.pointerId)) return
    active.set(e.pointerId, p)

    if (pinchPrev && active.size >= 2) {
      // Two-finger pinch: ONE step that both scales and pans. Anchor the grid
      // point that was under the PREVIOUS midpoint, and place it under the
      // CURRENT midpoint at the new zoom — this is pan + zoom combined, and it
      // degrades to a pure pan when the zoom hits its clamp.
      const cur = pinchOf([...active.values()])
      const scale = cur.dist / pinchPrev.dist
      const { zoom, viewOffset, setZoom, setViewOffset } = store.getState()
      const newZoom = clamp(zoom * scale, MIN_ZOOM, MAX_ZOOM)
      const gx = pinchPrev.midX / zoom + viewOffset.x
      const gy = pinchPrev.midY / zoom + viewOffset.y
      setZoom(newZoom)
      setViewOffset({ x: gx - cur.midX / newZoom, y: gy - cur.midY / newZoom })
      pinchPrev = cur
    } else if (panLast && active.size === 1) {
      pan(p.x - panLast.x, p.y - panLast.y)
      panLast = p
    }
  }

  const onPointerUp = (e: PointerEvent) => {
    canvas.releasePointerCapture(e.pointerId)

    if (e.pointerType === 'mouse') {
      panLast = null
      return
    }

    active.delete(e.pointerId)

    if (active.size < 2) pinchPrev = null
    if (active.size === 1) {
      // Dropped from pinch to one finger: rebaseline pan to the finger still
      // down, so the next move doesn't jump by the gap to the lifted finger.
      panLast = [...active.values()][0]
    } else if (active.size === 0) {
      panLast = null
    }
  }

  const onWheel = (e: WheelEvent) => {
    e.preventDefault() // stop the page from scrolling
    const rect = canvas.getBoundingClientRect()
    // Exponential so each wheel notch is a constant ZOOM RATIO, not a constant
    // additive step (feels uniform across the 2-40 range). deltaY < 0 = zoom in.
    const factor = Math.exp(-e.deltaY * 0.0015)
    const { zoom } = store.getState()
    zoomTo(zoom * factor, e.clientX - rect.left, e.clientY - rect.top)
  }

  const onContextMenu = (e: MouseEvent) => e.preventDefault() // right-drag != menu

  // --- Wire up + teardown ------------------------------------------------

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp) // OS stole the gesture
  // passive:false: we MUST be allowed to preventDefault to block page scroll.
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('contextmenu', onContextMenu)

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown)
    canvas.removeEventListener('pointermove', onPointerMove)
    canvas.removeEventListener('pointerup', onPointerUp)
    canvas.removeEventListener('pointercancel', onPointerUp)
    canvas.removeEventListener('wheel', onWheel)
    canvas.removeEventListener('contextmenu', onContextMenu)
  }
}
