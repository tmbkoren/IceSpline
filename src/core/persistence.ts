// Persists the track across page reloads via localStorage. We save the editable
// state (points, width, tangent visibility, camera) — NOT the undo history, which
// is explicitly out of scope (SPEC "Out of Scope"), nor gridBlocks, which is
// derived and recomputed on load.
//
// IMPORTANT: this module touches localStorage at runtime, so it must be imported
// only by the browser entry (main.tsx) — never by state.ts, which the node test
// suite imports (localStorage is undefined there).

import { store, type ControlPoint, type IceBlock, type Vec2 } from './state'
import { computeBlocks } from './blocks'

const KEY = 'icespline:v1'
const SAVE_DEBOUNCE_MS = 500

interface Persisted {
  points: ControlPoint[]
  curveWidth: number
  showTangents: boolean
  iceBlock: IceBlock
  zoom: number
  viewOffset: Vec2
}

// --- Validation: localStorage is untrusted (corrupt/old data must not crash the
//     renderer), so we check the shape before hydrating. ---

function isVec2(v: unknown): v is Vec2 {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.x === 'number' && Number.isFinite(o.x) &&
    typeof o.y === 'number' && Number.isFinite(o.y)
  )
}

function validPoints(arr: unknown): ControlPoint[] | null {
  if (!Array.isArray(arr)) return null
  for (const p of arr) {
    if (!p || typeof p !== 'object') return null
    const o = p as Record<string, unknown>
    if (!isVec2(o.pos) || !isVec2(o.inTangent) || !isVec2(o.outTangent)) return null
    if (typeof o.mirrored !== 'boolean') return null
  }
  return arr as ControlPoint[]
}

function clonePoints(pts: ControlPoint[]): ControlPoint[] {
  return pts.map((p) => ({
    pos: { ...p.pos },
    inTangent: { ...p.inTangent },
    outTangent: { ...p.outTangent },
    mirrored: p.mirrored,
  }))
}

/** Hydrate the store from localStorage. Call once, before the first render. */
export function loadPersisted(): void {
  let raw: string | null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return // storage unavailable (private mode, etc.) — start fresh
  }
  if (!raw) return

  let data: Partial<Persisted>
  try {
    data = JSON.parse(raw) as Partial<Persisted>
  } catch {
    return // corrupt JSON — ignore
  }

  const points = validPoints(data.points)
  if (!points) return // nothing usable

  const cur = store.getState()
  const curveWidth = typeof data.curveWidth === 'number' ? data.curveWidth : cur.curveWidth
  store.setState({
    points,
    curveWidth,
    showTangents: typeof data.showTangents === 'boolean' ? data.showTangents : cur.showTangents,
    iceBlock:
      data.iceBlock === 'packed_ice' || data.iceBlock === 'blue_ice' ? data.iceBlock : cur.iceBlock,
    zoom: typeof data.zoom === 'number' ? data.zoom : cur.zoom,
    viewOffset: isVec2(data.viewOffset) ? data.viewOffset : cur.viewOffset,
    selectedIndex: null,
    gridBlocks: computeBlocks(points, curveWidth),
    // Seed undo history with the loaded track as the baseline so the first undo
    // doesn't wipe to an empty canvas.
    undoStack: [clonePoints(points)],
    redoStack: [],
  })
}

/** Subscribe to the store and persist changes (debounced). Returns a teardown. */
export function startPersistence(): () => void {
  let timer: number | undefined

  const save = () => {
    try {
      const s = store.getState()
      const data: Persisted = {
        points: s.points,
        curveWidth: s.curveWidth,
        showTangents: s.showTangents,
        iceBlock: s.iceBlock,
        zoom: s.zoom,
        viewOffset: s.viewOffset,
      }
      localStorage.setItem(KEY, JSON.stringify(data))
    } catch {
      // quota/unavailable — drop this save silently
    }
  }

  // The store fires on every edit (and ~60x/sec during a drag), so coalesce to
  // at most one write per debounce window.
  const unsub = store.subscribe(() => {
    if (timer !== undefined) return
    timer = window.setTimeout(() => {
      timer = undefined
      save()
    }, SAVE_DEBOUNCE_MS)
  })

  // Catch the latest state when the tab is hidden/closed (covers mobile, where
  // 'unload' is unreliable).
  window.addEventListener('pagehide', save)

  return () => {
    unsub()
    window.removeEventListener('pagehide', save)
    if (timer !== undefined) clearTimeout(timer)
  }
}
