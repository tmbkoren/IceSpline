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

  // --- actions (skeleton subset; geometry + undo actions come later) ---
  setCurveWidth: (w: number) => void
  setZoom: (z: number) => void
  setViewOffset: (o: Vec2) => void
  toggleBuildMode: () => void
  toggleTangents: () => void
}

// --- The store ------------------------------------------------------------

// `createStore` (the vanilla flavor) returns an object with getState(),
// setState(), and subscribe() — usable anywhere, no React required. The
// canvas renderer imports THIS `store` directly.
export const store = createStore<AppState>((set) => ({
  // initial data
  points: [],
  selectedIndex: null,
  curveWidth: 3,
  showTangents: true,
  isBuildMode: false,
  gridBlocks: new Set(),
  highlightedBlocks: new Set(),
  zoom: 10,
  viewOffset: { x: 0, y: 0 },
  undoStack: [[]], // history starts with one empty snapshot
  redoStack: [],

  // actions. `set` does a shallow MERGE of the returned partial into state,
  // so we only name the keys that change. Returning a new value (not mutating
  // in place) is what notifies subscribers.
  setCurveWidth: (curveWidth) => set({ curveWidth }),
  setZoom: (zoom) => set({ zoom }),
  setViewOffset: (viewOffset) => set({ viewOffset }),

  // For toggles we need the previous value, so we pass `set` a function that
  // receives the current state `s` and returns the change.
  toggleBuildMode: () => set((s) => ({ isBuildMode: !s.isBuildMode })),
  toggleTangents: () => set((s) => ({ showTangents: !s.showTangents })),
}))

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
