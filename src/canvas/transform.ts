// The one true camera transform, shared by the renderer (grid -> screen) and
// input/hit-testing (screen -> grid). These are exact inverses; keeping them in
// ONE place is deliberate — input.ts used to inline `ax/zoom + viewOffset.x`,
// and any drift between that and the renderer's `(g - viewOffset) * zoom` would
// make clicks miss what's drawn. Pure functions, no store import: callers pass
// the camera they already hold.

import type { Vec2 } from '../core/state'

/** Grid (world) coordinate -> screen pixel, given the camera. */
export function gridToScreen(gx: number, gy: number, zoom: number, viewOffset: Vec2): Vec2 {
  return { x: (gx - viewOffset.x) * zoom, y: (gy - viewOffset.y) * zoom }
}

/** Screen pixel -> grid (world) coordinate, given the camera. The inverse. */
export function screenToGrid(sx: number, sy: number, zoom: number, viewOffset: Vec2): Vec2 {
  return { x: sx / zoom + viewOffset.x, y: sy / zoom + viewOffset.y }
}
