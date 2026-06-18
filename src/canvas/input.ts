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
import { downloadMtrack, openMtrackDialog } from '../core/mtrack'
import { gridToScreen, screenToGrid } from './transform'

// Camera limits (SPEC: zoom slider 2-40 px/block).
const MIN_ZOOM = 2
const MAX_ZOOM = 40

// How close (screen px) a left-click must be to a control point to grab it.
const HIT_RADIUS_PX = 8
// Movement (screen px) below which a left press+release counts as a click, not a
// drag — so a click on empty space adds a point, but a stray drag doesn't.
const DRAG_THRESHOLD_PX = 4
// Fingers are less precise than a mouse, so touch uses a looser tap tolerance
// (also the distance a finger may wander before a long-press is cancelled).
const TAP_TOLERANCE_PX = 10
// Hold a point this long (ms) without moving to delete it on touch.
const LONG_PRESS_MS = 500

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

  // Active left-button edit gesture (mouse): dragging an anchor, dragging a
  // tangent handle, or a press on empty space (add a point on release if it was
  // a click, not a drag). null when no left edit is in progress.
  let editing:
    | { kind: 'anchor'; index: number }
    | { kind: 'handle'; index: number; which: 'in' | 'out' }
    | { kind: 'empty'; downX: number; downY: number }
    | null = null

  // Touch-only: the position the active finger went down at (tap detection +
  // long-press cancel) and the pending long-press-to-delete timer.
  let pressStart: { x: number; y: number } | null = null
  let longPressTimer: number | null = null
  const clearLongPress = () => {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer)
      longPressTimer = null
    }
  }

  // --- Helpers -----------------------------------------------------------

  type Hit =
    | { kind: 'anchor'; index: number }
    | { kind: 'handle'; index: number; which: 'in' | 'out' }
    | { kind: 'curve'; index: number; t: number }

  // Topmost thing within range of screen point `p`, or null. SPEC hit order:
  // for each point (last->first), in-handle -> out-handle -> anchor; then the
  // curve itself; then empty space (null). Zero-length handles are skipped —
  // they coincide with the anchor and have nothing to grab.
  const hitTest = (p: { x: number; y: number }): Hit | null => {
    const { points, zoom, viewOffset, showTangents, curveWidth } = store.getState()
    const near = (gx: number, gy: number) => {
      const s = gridToScreen(gx, gy, zoom, viewOffset)
      const dx = p.x - s.x
      const dy = p.y - s.y
      return dx * dx + dy * dy <= HIT_RADIUS_PX * HIT_RADIUS_PX
    }
    for (let i = points.length - 1; i >= 0; i--) {
      const pt = points[i]
      if (showTangents) {
        const handles = [
          { which: 'in' as const, t: pt.inTangent },
          { which: 'out' as const, t: pt.outTangent },
        ]
        for (const { which, t } of handles) {
          if (t.x === 0 && t.y === 0) continue
          if (near(pt.pos.x + t.x, pt.pos.y + t.y)) return { kind: 'handle', index: i, which }
        }
      }
      if (near(pt.pos.x, pt.pos.y)) return { kind: 'anchor', index: i }
    }

    // Curve hit: sample each cubic and find the nearest point to the click. The
    // "near curve" threshold scales with the rendered road width (SPEC 312).
    const CURVE_STEPS = 24
    const thresholdPx = (curveWidth * zoom) / 2 + 5
    let best: { index: number; t: number; d2: number } | null = null
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i]
      const p1 = points[i + 1]
      const c0 = p0.pos
      const c1 = { x: p0.pos.x + p0.outTangent.x, y: p0.pos.y + p0.outTangent.y }
      const c2 = { x: p1.pos.x + p1.inTangent.x, y: p1.pos.y + p1.inTangent.y }
      const c3 = p1.pos
      for (let k = 0; k <= CURVE_STEPS; k++) {
        const t = k / CURVE_STEPS
        const u = 1 - t
        const b0 = u * u * u
        const b1 = 3 * u * u * t
        const b2 = 3 * u * t * t
        const b3 = t * t * t
        const gx = b0 * c0.x + b1 * c1.x + b2 * c2.x + b3 * c3.x
        const gy = b0 * c0.y + b1 * c1.y + b2 * c2.y + b3 * c3.y
        const s = gridToScreen(gx, gy, zoom, viewOffset)
        const dx = p.x - s.x
        const dy = p.y - s.y
        const d2 = dx * dx + dy * dy
        if (best === null || d2 < best.d2) best = { index: i, t, d2 }
      }
    }
    if (best && best.d2 <= thresholdPx * thresholdPx) {
      return { kind: 'curve', index: best.index, t: best.t }
    }
    return null
  }

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
      if (e.button === 2) {
        // Right button: pan.
        panLast = p
        canvas.setPointerCapture(e.pointerId)
      } else if (e.button === 1) {
        // Middle button: delete the anchor under the cursor (records history).
        // Handles aren't deletable, so only an anchor hit counts. preventDefault
        // stops the browser's middle-click autoscroll.
        e.preventDefault()
        const hit = hitTest(p)
        if (hit?.kind === 'anchor') store.getState().deletePoint(hit.index)
      } else if (e.button === 0) {
        // Left button: grab an anchor or a tangent handle, or arm an
        // add-on-release if pressed over empty space.
        const hit = hitTest(p)
        if (hit?.kind === 'anchor') {
          store.getState().select(hit.index)
          editing = { kind: 'anchor', index: hit.index }
        } else if (hit?.kind === 'handle') {
          store.getState().select(hit.index)
          editing = { kind: 'handle', index: hit.index, which: hit.which }
        } else if (hit?.kind === 'curve') {
          // Insert a node on the curve (exact split), then immediately let the
          // user drag the new anchor — it lands at index hit.index + 1.
          store.getState().insertPoint(hit.index, hit.t)
          editing = { kind: 'anchor', index: hit.index + 1 }
        } else {
          editing = { kind: 'empty', downX: p.x, downY: p.y }
        }
        canvas.setPointerCapture(e.pointerId)
      }
      return
    }

    // Touch / pen. Capture so moves keep arriving even if the finger slides off
    // the canvas mid-drag.
    canvas.setPointerCapture(e.pointerId)
    active.set(e.pointerId, p)

    if (active.size === 1) {
      // One finger: same hit-test as the mouse left button. A point/handle starts
      // a move, the curve inserts, empty space arms a tap-to-add and lets a drag
      // pan. Holding still on a point deletes it (long-press).
      pressStart = p
      const hit = hitTest(p)
      if (hit?.kind === 'anchor') {
        store.getState().select(hit.index)
        editing = { kind: 'anchor', index: hit.index }
        longPressTimer = window.setTimeout(() => {
          store.getState().deletePoint(hit.index)
          editing = null
          longPressTimer = null
        }, LONG_PRESS_MS)
      } else if (hit?.kind === 'handle') {
        store.getState().select(hit.index)
        editing = { kind: 'handle', index: hit.index, which: hit.which }
      } else if (hit?.kind === 'curve') {
        store.getState().insertPoint(hit.index, hit.t)
        editing = { kind: 'anchor', index: hit.index + 1 }
      } else {
        editing = { kind: 'empty', downX: p.x, downY: p.y }
        panLast = p // empty one-finger drag pans
      }
      pinchPrev = null
    } else if (active.size === 2) {
      // Second finger down -> abandon any one-finger edit and switch to pinch.
      clearLongPress()
      editing = null
      panLast = null
      pinchPrev = pinchOf([...active.values()])
    }
    // 3+ fingers: ignore the extras; the first two still drive the pinch.
  }

  const onPointerMove = (e: PointerEvent) => {
    const p = pos(e)

    if (e.pointerType === 'mouse') {
      if (editing?.kind === 'anchor') {
        // Drag the grabbed anchor. Shift = fix tangents in world space.
        const { zoom, viewOffset } = store.getState()
        const g = screenToGrid(p.x, p.y, zoom, viewOffset)
        store.getState().movePoint(editing.index, g, e.shiftKey)
        return
      }
      if (editing?.kind === 'handle') {
        // Drag a tangent handle (mirrors the opposite handle if the point is
        // mirrored — handled in the store).
        const { zoom, viewOffset } = store.getState()
        const g = screenToGrid(p.x, p.y, zoom, viewOffset)
        store.getState().moveTangent(editing.index, editing.which, g)
        return
      }
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
    } else if (active.size === 1) {
      // Any meaningful movement cancels a pending long-press delete.
      if (pressStart) {
        const mx = p.x - pressStart.x
        const my = p.y - pressStart.y
        if (mx * mx + my * my > TAP_TOLERANCE_PX * TAP_TOLERANCE_PX) clearLongPress()
      }
      const { zoom, viewOffset } = store.getState()
      if (editing?.kind === 'anchor') {
        // No Shift on touch, so tangents are never fixed here.
        store.getState().movePoint(editing.index, screenToGrid(p.x, p.y, zoom, viewOffset), false)
      } else if (editing?.kind === 'handle') {
        store.getState().moveTangent(editing.index, editing.which, screenToGrid(p.x, p.y, zoom, viewOffset))
      } else if (panLast) {
        pan(p.x - panLast.x, p.y - panLast.y)
        panLast = p
      }
    }
  }

  const onPointerUp = (e: PointerEvent) => {
    canvas.releasePointerCapture(e.pointerId)

    if (e.pointerType === 'mouse') {
      if (editing?.kind === 'anchor' || editing?.kind === 'handle') {
        // End of a move-drag: commit one history snapshot (no-op if unchanged).
        store.getState().commitEdit()
        editing = null
      } else if (editing?.kind === 'empty') {
        // Pressed empty space: add a point only if this was a click, not a drag.
        const p = pos(e)
        const dx = p.x - editing.downX
        const dy = p.y - editing.downY
        if (dx * dx + dy * dy <= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
          const { zoom, viewOffset } = store.getState()
          store.getState().addPoint(screenToGrid(editing.downX, editing.downY, zoom, viewOffset))
        }
        editing = null
      }
      panLast = null
      return
    }

    clearLongPress()
    const p = pos(e)
    active.delete(e.pointerId)

    // The last finger lifting ends a one-finger edit: commit a move, or add a
    // point if it was a tap on empty space (not a pan). (After a pinch, `editing`
    // was already cleared, so neither fires.)
    if (active.size === 0) {
      if (editing?.kind === 'anchor' || editing?.kind === 'handle') {
        store.getState().commitEdit()
        editing = null
      } else if (editing?.kind === 'empty') {
        const dx = p.x - editing.downX
        const dy = p.y - editing.downY
        if (dx * dx + dy * dy <= TAP_TOLERANCE_PX * TAP_TOLERANCE_PX) {
          const { zoom, viewOffset } = store.getState()
          store.getState().addPoint(screenToGrid(editing.downX, editing.downY, zoom, viewOffset))
        }
        editing = null
      }
      pressStart = null
    }

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

  // Keyboard shortcuts (SPEC: Design Mode editing). Window-level because the
  // <canvas> isn't focusable. We bail if the user is typing in a form control
  // so e.g. pressing "c" in the width field doesn't clear the whole track.
  const onKeyDown = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null
    if (
      el &&
      (el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT' ||
        el.isContentEditable)
    ) {
      return
    }

    const s = store.getState()

    // Undo/redo: Ctrl+Z (or Cmd+Z), Ctrl+Y, and Ctrl/Cmd+Shift+Z for the Mac
    // habit. preventDefault so the browser's own undo doesn't also fire.
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase()
      if (k === 'z') {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
      } else if (k === 'y') {
        e.preventDefault()
        s.redo()
      } else if (k === 's') {
        // Export .mtrack (stop the browser's "save page" dialog).
        e.preventDefault()
        downloadMtrack(s.points)
      } else if (k === 'o') {
        // Import .mtrack (stop the browser's "open file" dialog).
        e.preventDefault()
        openMtrackDialog()
          .then((points) => {
            if (points) store.getState().loadTrack(points)
          })
          .catch((err: Error) => window.alert(`Couldn't import .mtrack: ${err.message}`))
      }
      return
    }

    switch (e.key.toLowerCase()) {
      case 'c': // clear all (records history)
        s.clearPoints()
        break
      case 'm': // toggle tangent mirroring on the selected point
        if (s.selectedIndex !== null) s.toggleMirror(s.selectedIndex)
        break
      case 't': // toggle global tangent visibility
        s.toggleTangents()
        break
    }
  }

  // --- Wire up + teardown ------------------------------------------------

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp) // OS stole the gesture
  // passive:false: we MUST be allowed to preventDefault to block page scroll.
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('contextmenu', onContextMenu)
  window.addEventListener('keydown', onKeyDown)

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown)
    canvas.removeEventListener('pointermove', onPointerMove)
    canvas.removeEventListener('pointerup', onPointerUp)
    canvas.removeEventListener('pointercancel', onPointerUp)
    canvas.removeEventListener('wheel', onWheel)
    canvas.removeEventListener('contextmenu', onContextMenu)
    window.removeEventListener('keydown', onKeyDown)
  }
}
