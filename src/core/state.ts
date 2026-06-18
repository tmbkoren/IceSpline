// The single source of truth for the whole app.
//
// We use Zustand, but in a deliberate two-layer shape:
//   1. a *vanilla* store (plain JS object, no React) that the imperative
//      canvas RAF loop reads directly via getState()/subscribe();
//   2. a thin React hook (useStore) that the UI "chrome" (panel, dialogs)
//      uses to re-render when the slices it cares about change.
// This split is what lets the canvas read `points` 60x/second WITHOUT ever
// re-rendering React — the cardinal architecture rule (see CLAUDE.md rules 1-2).

import { createStore } from 'zustand/vanilla'
import { useStore as useZustand } from 'zustand'
import { computeBlocks } from './blocks'
import { getViewport } from './viewport'

// Undo history cap (SPEC: 50 states). Older snapshots fall off the front.
const MAX_HISTORY = 50

// --- Domain types ---------------------------------------------------------

/** A 2D point/vector in *grid* (world) coordinates, not screen pixels. */
export interface Vec2 {
  x: number
  y: number
}

/**
 * One node of the Bézier spline the user drags around.
 * `pos` is the anchor; `inTangent`/`outTangent` are the two Bézier control
 * handles flanking it (incoming and outgoing). When `mirrored` is true,
 * moving one handle reflects the other through `pos` for a smooth curve.
 *
 * NOTE: field names are camelCase here. The on-disk .mtrack format uses
 * in_tangent/out_tangent — we convert at the I/O boundary, never here
 * (CLAUDE.md rule 5).
 */
export interface ControlPoint {
  pos: Vec2
  inTangent: Vec2
  outTangent: Vec2
  mirrored: boolean
}

/**
 * The complete app state: data + the action functions that mutate it.
 * Keeping actions *inside* the store (rather than free functions) is the
 * idiomatic Zustand pattern — every mutation goes through `set`, so there's
 * exactly one place state changes and subscribers always fire.
 */
export interface AppState {
  // --- curve data ---
  points: ControlPoint[]
  selectedIndex: number | null
  curveWidth: number

  // --- view / display toggles ---
  showTangents: boolean
  isBuildMode: boolean

  // --- rasterized output ---
  // Blocks are keyed as "x,y" strings so we get O(1) set membership and
  // automatic dedup. A Set of {x,y} objects wouldn't dedup (object identity),
  // hence the string key.
  gridBlocks: Set<string>
  highlightedBlocks: Set<string>

  // --- camera ---
  zoom: number // pixels per grid unit
  viewOffset: Vec2 // top-left grid coord visible at screen (0,0)

  // --- history (snapshots of `points`; wired up in a later milestone) ---
  undoStack: ControlPoint[][]
  redoStack: ControlPoint[][]

  // --- display / camera actions ---
  setCurveWidth: (w: number) => void
  setZoom: (z: number) => void
  setViewOffset: (o: Vec2) => void
  toggleBuildMode: () => void
  toggleTangents: () => void

  // --- selection (no history; not a curve edit) ---
  select: (index: number | null) => void

  // --- geometry edits ---
  // `addPoint` appends a new node to whichever endpoint is nearer the click
  // (SPEC); discrete, so it records history. `movePoint`/`moveTangent` run on
  // every drag frame and therefore record NO history — `commitEdit` (called
  // once on pointer-up) snapshots the result instead. `fixTangents` (Shift-drag)
  // holds the tangent handles at fixed WORLD positions while the anchor moves.
  addPoint: (grid: Vec2) => void
  // Split segment [segIndex, segIndex+1] at parameter t via de Casteljau, so the
  // curve shape is preserved exactly; records history.
  insertPoint: (segIndex: number, t: number) => void
  movePoint: (index: number, grid: Vec2, fixTangents: boolean) => void
  moveTangent: (index: number, which: 'in' | 'out', grid: Vec2) => void
  deletePoint: (index: number) => void
  clearPoints: () => void
  toggleMirror: (index: number) => void
  // Replace the whole track (e.g. .mtrack import); records history so it's undoable.
  loadTrack: (points: ControlPoint[]) => void

  // --- history ---
  // commitEdit closes a drag: push a snapshot iff the points actually changed.
  commitEdit: () => void
  undo: () => void
  redo: () => void
}

// --- Helpers (module-level, framework-free) -------------------------------

/** Deep copy of a point list — history snapshots must not alias live state. */
function clonePoints(pts: ControlPoint[]): ControlPoint[] {
  return pts.map((p) => ({
    pos: { ...p.pos },
    inTangent: { ...p.inTangent },
    outTangent: { ...p.outTangent },
    mirrored: p.mirrored,
  }))
}

/** Structural equality of two point lists — used to skip empty commits. */
function samePoints(a: ControlPoint[], b: ControlPoint[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const p = a[i]
    const q = b[i]
    if (
      p.pos.x !== q.pos.x ||
      p.pos.y !== q.pos.y ||
      p.inTangent.x !== q.inTangent.x ||
      p.inTangent.y !== q.inTangent.y ||
      p.outTangent.x !== q.outTangent.x ||
      p.outTangent.y !== q.outTangent.y ||
      p.mirrored !== q.mirrored
    ) {
      return false
    }
  }
  return true
}

// --- The store ------------------------------------------------------------

// `createStore` (the vanilla flavor) returns an object with getState(),
// setState(), and subscribe() — usable anywhere, no React required. The
// canvas renderer imports THIS `store` directly.
export const store = createStore<AppState>((set, get) => {
  // `gridBlocks` is DERIVED from `points` + `curveWidth` — it is never edited
  // directly and never goes into undo history (only `points` does). Every
  // geometry mutation routes through `setPoints`, which is the single place we
  // recompute blocks (TS reference now; WASM + incremental in the perf pass).
  const setPoints = (pts: ControlPoint[], recordHistory: boolean) => {
    const s = get()
    const next: Partial<AppState> = {
      points: pts,
      gridBlocks: computeBlocks(pts, s.curveWidth),
    }
    if (recordHistory) {
      next.undoStack = [...s.undoStack, clonePoints(pts)].slice(-MAX_HISTORY)
      next.redoStack = [] // any fresh edit invalidates the redo branch
    }
    set(next)
  }

  return {
    // initial data
    points: [],
    selectedIndex: null,
    curveWidth: 10,
    showTangents: true,
    isBuildMode: false,
    gridBlocks: new Set(),
    highlightedBlocks: new Set(),
    zoom: 10,
    viewOffset: { x: 0, y: 0 },
    undoStack: [[]], // history starts with one empty baseline snapshot
    redoStack: [],

    // --- display / camera. `set` shallow-MERGES the returned partial, so we
    //     only name the keys that change. ---
    // Width changes the rasterized blocks, so recompute (but it's not a
    // geometry edit, so no history entry).
    setCurveWidth: (curveWidth) =>
      set({ curveWidth, gridBlocks: computeBlocks(get().points, curveWidth) }),
    setZoom: (zoom) => set({ zoom }),
    setViewOffset: (viewOffset) => set({ viewOffset }),
    toggleBuildMode: () => set((s) => ({ isBuildMode: !s.isBuildMode })),
    toggleTangents: () => set((s) => ({ showTangents: !s.showTangents })),

    select: (selectedIndex) => set({ selectedIndex }),

    // --- geometry edits ---

    addPoint: (grid) => {
      const pts = get().points
      // The first point has no neighbour to orient against, so it starts with
      // zero tangents (its handles stay hidden until it gets a neighbour or the
      // user drags one out).
      if (pts.length === 0) {
        const fresh: ControlPoint = {
          pos: { x: grid.x, y: grid.y },
          inTangent: { x: 0, y: 0 },
          outTangent: { x: 0, y: 0 },
          mirrored: false,
        }
        set({ selectedIndex: 0 })
        setPoints([fresh], true)
        return
      }
      // Otherwise append to whichever endpoint is nearer the click (SPEC), and
      // seed tangents along the chord to that neighbour so the handles are
      // immediately visible and grabbable (out = forward along the chain, in =
      // its reflection). AUTO_TANGENT is the fraction of the chord used.
      const AUTO_TANGENT = 0.3
      const first = pts[0].pos
      const last = pts[pts.length - 1].pos
      const d0 = (grid.x - first.x) ** 2 + (grid.y - first.y) ** 2
      const d1 = (grid.x - last.x) ** 2 + (grid.y - last.y) ** 2
      const prepend = d0 < d1
      // Vector pointing "forward" along the chain from the new point: toward the
      // first point if prepending, away from the last point if appending.
      const fx = (prepend ? first.x : grid.x) - (prepend ? grid.x : last.x)
      const fy = (prepend ? first.y : grid.y) - (prepend ? grid.y : last.y)
      const inTangent = { x: -fx * AUTO_TANGENT, y: -fy * AUTO_TANGENT }
      const outTangent = { x: fx * AUTO_TANGENT, y: fy * AUTO_TANGENT }
      const fresh: ControlPoint = {
        pos: { x: grid.x, y: grid.y },
        inTangent,
        outTangent,
        mirrored: false,
      }
      // If the endpoint we're attaching to still has zero tangents (e.g. the
      // lone first point), seed it along the same chord so it gets handles too —
      // otherwise a 2-point curve would show handles on one end only.
      const neighbor = prepend ? pts[0] : pts[pts.length - 1]
      const neighborIsBare =
        neighbor.inTangent.x === 0 &&
        neighbor.inTangent.y === 0 &&
        neighbor.outTangent.x === 0 &&
        neighbor.outTangent.y === 0
      const seededNeighbor: ControlPoint = neighborIsBare
        ? { ...neighbor, inTangent: { ...inTangent }, outTangent: { ...outTangent } }
        : neighbor
      if (prepend) {
        set({ selectedIndex: 0 })
        setPoints([fresh, seededNeighbor, ...pts.slice(1)], true)
      } else {
        const next = [...pts.slice(0, -1), seededNeighbor, fresh]
        set({ selectedIndex: next.length - 1 })
        setPoints(next, true)
      }
    },

    insertPoint: (segIndex, t) => {
      const pts = get().points
      if (segIndex < 0 || segIndex >= pts.length - 1) return
      const p0 = pts[segIndex]
      const p1 = pts[segIndex + 1]
      // The segment's four absolute Bézier control points (tangents are offsets).
      const P0 = p0.pos
      const P1 = { x: p0.pos.x + p0.outTangent.x, y: p0.pos.y + p0.outTangent.y }
      const P2 = { x: p1.pos.x + p1.inTangent.x, y: p1.pos.y + p1.inTangent.y }
      const P3 = p1.pos
      // de Casteljau at t: repeated linear interpolation. The intermediate
      // points give the control polygons of the two sub-cubics that together
      // reproduce the original curve EXACTLY:
      //   left  = [P0, A, D, F]    right = [F, E, C, P3]
      const lerp = (a: Vec2, b: Vec2): Vec2 => ({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
      })
      const A = lerp(P0, P1)
      const B = lerp(P1, P2)
      const C = lerp(P2, P3)
      const D = lerp(A, B)
      const E = lerp(B, C)
      const F = lerp(D, E) // the split point — new anchor position

      // Rewrite the flanking nodes' inner handles and insert the new node.
      // Tangents are stored relative to each anchor's pos.
      const left: ControlPoint = {
        pos: { ...p0.pos },
        inTangent: { ...p0.inTangent },
        outTangent: { x: A.x - P0.x, y: A.y - P0.y },
        mirrored: p0.mirrored,
      }
      const mid: ControlPoint = {
        pos: { x: F.x, y: F.y },
        inTangent: { x: D.x - F.x, y: D.y - F.y },
        outTangent: { x: E.x - F.x, y: E.y - F.y },
        // The two handles are collinear (D, F, E are colinear) but unequal in
        // length, so it's smooth-but-not-mirrored; forcing mirrored would break
        // the exact reproduction.
        mirrored: false,
      }
      const right: ControlPoint = {
        pos: { ...p1.pos },
        inTangent: { x: C.x - P3.x, y: C.y - P3.y },
        outTangent: { ...p1.outTangent },
        mirrored: p1.mirrored,
      }
      const next = pts.slice()
      next[segIndex] = left
      next[segIndex + 1] = right
      next.splice(segIndex + 1, 0, mid)
      set({ selectedIndex: segIndex + 1 })
      setPoints(next, true)
    },

    movePoint: (index, grid, fixTangents) => {
      const pts = get().points
      const p = pts[index]
      if (!p) return
      const dx = grid.x - p.pos.x
      const dy = grid.y - p.pos.y
      // Default: move only the anchor; tangents are relative offsets, so the
      // handles follow for free. Shift-drag (fixTangents): subtract the delta
      // from each tangent so the handles stay put in WORLD space.
      const moved: ControlPoint = {
        pos: { x: grid.x, y: grid.y },
        inTangent: fixTangents
          ? { x: p.inTangent.x - dx, y: p.inTangent.y - dy }
          : { ...p.inTangent },
        outTangent: fixTangents
          ? { x: p.outTangent.x - dx, y: p.outTangent.y - dy }
          : { ...p.outTangent },
        mirrored: p.mirrored,
      }
      const next = pts.slice()
      next[index] = moved
      setPoints(next, false) // drag frame — history deferred to commitEdit
    },

    moveTangent: (index, which, grid) => {
      const pts = get().points
      const p = pts[index]
      if (!p) return
      // Handle position is stored as an offset from the anchor.
      const t = { x: grid.x - p.pos.x, y: grid.y - p.pos.y }
      const opp = { x: -t.x, y: -t.y } // reflection through the anchor
      const moved: ControlPoint = {
        pos: { ...p.pos },
        inTangent: which === 'in' ? t : p.mirrored ? opp : { ...p.inTangent },
        outTangent: which === 'out' ? t : p.mirrored ? opp : { ...p.outTangent },
        mirrored: p.mirrored,
      }
      const next = pts.slice()
      next[index] = moved
      setPoints(next, false)
    },

    deletePoint: (index) => {
      const pts = get().points
      if (index < 0 || index >= pts.length) return
      const next = pts.slice()
      next.splice(index, 1)
      set({ selectedIndex: null })
      setPoints(next, true)
    },

    clearPoints: () => {
      set({ selectedIndex: null })
      setPoints([], true)
    },

    loadTrack: (points) => {
      const cloned = clonePoints(points)
      set({ selectedIndex: null })
      setPoints(cloned, true)
      // Fit the whole track to the screen so an imported track is fully visible —
      // the camera may have been parked far from where this track lives.
      const { width: vpW, height: vpH } = getViewport()
      if (cloned.length === 0 || vpW <= 0 || vpH <= 0) return

      // Bounding box over anchors AND tangent-handle tips (the curve can bulge out
      // to the handles), in grid units.
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const p of cloned) {
        for (const x of [p.pos.x, p.pos.x + p.inTangent.x, p.pos.x + p.outTangent.x]) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
        }
        for (const y of [p.pos.y, p.pos.y + p.inTangent.y, p.pos.y + p.outTangent.y]) {
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }

      const PADDING = 0.85 // leave a margin around the track
      const MIN_ZOOM = 2 // matches input.ts / the SPEC zoom slider (2–40 px/block)
      const MAX_ZOOM = 40
      const spanX = maxX - minX
      const spanY = maxY - minY
      // Zoom to fit the tighter axis; a zero span (single point / axis-aligned
      // line) doesn't constrain zoom, so leave that axis out (avoid /0).
      const fitX = spanX > 0 ? (vpW * PADDING) / spanX : Infinity
      const fitY = spanY > 0 ? (vpH * PADDING) / spanY : Infinity
      const fit = Math.min(fitX, fitY)
      const zoom = fit === Infinity ? get().zoom : Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fit))

      // Center the bounding box: viewOffset is the grid coord at screen (0,0).
      const cx = (minX + maxX) / 2
      const cy = (minY + maxY) / 2
      set({ zoom, viewOffset: { x: cx - vpW / 2 / zoom, y: cy - vpH / 2 / zoom } })
    },

    toggleMirror: (index) => {
      const pts = get().points
      const p = pts[index]
      if (!p) return
      const nowMirrored = !p.mirrored
      const moved: ControlPoint = {
        pos: { ...p.pos },
        // When enabling, snap the in-handle to the reflection of the out-handle
        // so the curve is immediately smooth through the anchor.
        inTangent: nowMirrored
          ? { x: -p.outTangent.x, y: -p.outTangent.y }
          : { ...p.inTangent },
        outTangent: { ...p.outTangent },
        mirrored: nowMirrored,
      }
      const next = pts.slice()
      next[index] = moved
      setPoints(next, true)
    },

    // --- history ---

    commitEdit: () => {
      const s = get()
      const top = s.undoStack[s.undoStack.length - 1]
      if (samePoints(top, s.points)) return // drag ended where it began — skip
      set({
        undoStack: [...s.undoStack, clonePoints(s.points)].slice(-MAX_HISTORY),
        redoStack: [],
      })
    },

    undo: () => {
      const s = get()
      if (s.undoStack.length <= 1) return // only the baseline left — no-op
      const current = s.undoStack[s.undoStack.length - 1]
      const undoStack = s.undoStack.slice(0, -1)
      const restored = undoStack[undoStack.length - 1]
      set({
        undoStack,
        redoStack: [...s.redoStack, current],
        selectedIndex: null,
        points: clonePoints(restored),
        gridBlocks: computeBlocks(restored, s.curveWidth),
      })
    },

    redo: () => {
      const s = get()
      if (s.redoStack.length === 0) return
      const restored = s.redoStack[s.redoStack.length - 1]
      set({
        redoStack: s.redoStack.slice(0, -1),
        undoStack: [...s.undoStack, clonePoints(restored)].slice(-MAX_HISTORY),
        selectedIndex: null,
        points: clonePoints(restored),
        gridBlocks: computeBlocks(restored, s.curveWidth),
      })
    },
  }
})

// --- The React bridge -----------------------------------------------------

/**
 * Hook for React components (the chrome only). Pass a *selector* that picks
 * the smallest slice you need; the component re-renders only when that slice
 * changes (Zustand does the equality check).
 *
 * CARDINAL RULE: never select `points` from a mounted component — that would
 * re-render React on every drag frame, the exact stutter the canvas/store
 * split exists to avoid (CLAUDE.md rule 2). The canvas reads `points` through
 * the vanilla `store` above instead.
 */
export function useStore<T>(selector: (s: AppState) => T): T {
  return useZustand(store, selector)
}
