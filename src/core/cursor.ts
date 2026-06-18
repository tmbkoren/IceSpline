// The current cursor position over the canvas, in SCREEN (CSS) pixels. Like
// viewport.ts, this is a transient runtime fact — NOT app state, so it lives
// outside the store (never persisted, never in undo history, never triggers a
// React re-render). input.ts writes it on every pointermove and clears it when
// the pointer leaves the canvas; the renderer reads it to draw the coordinate
// label (draw-order slot 8). Keeping it out of the store is what lets the label
// follow the cursor 60x/sec without any React churn (CLAUDE.md rules 1-2).

let x = 0
let y = 0
let active = false

export function setCursor(sx: number, sy: number): void {
  x = sx
  y = sy
  active = true
}

export function clearCursor(): void {
  active = false
}

export function getCursor(): { x: number; y: number; active: boolean } {
  return { x, y, active }
}
