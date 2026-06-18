// The current canvas viewport size, in CSS pixels. This is a transient runtime
// fact — NOT app state, so it lives outside the store (never persisted, never in
// undo history). CanvasView writes it on mount/resize; camera math that needs the
// screen size reads it (e.g. centering the view on the first point at import).

let width = 0
let height = 0

export function setViewport(w: number, h: number): void {
  width = w
  height = h
}

export function getViewport(): { width: number; height: number } {
  return { width, height }
}
