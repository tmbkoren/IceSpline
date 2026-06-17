// The imperative draw loop — the NON-React half of the app.
//
// This file never imports React, never calls setState, never re-renders.
// It reads the store directly via store.getState() and paints pixels with
// the raw Canvas2D API, once per animation frame. This is the deliberate
// opposite of the UI: the UI subscribes and re-renders; the canvas polls
// and repaints. Reading `points` here 60x/sec is FREE because there's no
// React in the loop (CLAUDE.md rules 1-3).

import { store } from '../core/state'

/**
 * Starts the draw loop on the given canvas and returns a cleanup function
 * that stops it. The caller (CanvasView) runs cleanup on unmount, which is
 * what makes this safe under React StrictMode's mount/unmount/remount.
 */
export function startRenderLoop(canvas: HTMLCanvasElement): () => void {
  // The "2D context" is the actual drawing API — every ctx.* call below
  // (fillRect, stroke, ...) paints onto this canvas. getContext can return
  // null in theory (unsupported), hence the `!` — we assume 2D is available.
  const ctx = canvas.getContext('2d')!

  // Holds the id of the pending animation frame so cleanup can cancel it.
  let raf = 0

  const draw = () => {
    // Pull the CURRENT state every frame. No subscription, no hook — just a
    // snapshot read. Whatever the UI or input last wrote, we see it here.
    const { zoom, viewOffset } = store.getState()
    const { width, height } = canvas

    // 1) Clear/paint the background. We repaint the whole canvas each frame
    //    rather than tracking dirty regions — simple, and fine at this scale.
    ctx.fillStyle = '#282c34'
    ctx.fillRect(0, 0, width, height)

    // 2) Grid lines. Skip them when zoomed out so far they'd be solid noise.
    //    `zoom` is pixels-per-grid-unit; below ~3px per cell, don't bother.
    if (zoom > 3) {
      ctx.strokeStyle = '#3a3f4b'
      ctx.lineWidth = 1
      ctx.beginPath()

      // viewOffset is the grid coord shown at screen pixel (0,0). To convert
      // a grid coord `g` to a screen pixel: (g - viewOffset) * zoom.
      // We start at the first whole grid line at/after the left/top edge and
      // step by 1 grid unit until we march off the right/bottom of the canvas.
      const startX = Math.floor(viewOffset.x)
      const startY = Math.floor(viewOffset.y)

      for (let gx = startX; (gx - viewOffset.x) * zoom < width; gx++) {
        const sx = Math.round((gx - viewOffset.x) * zoom) // round → crisp 1px line
        ctx.moveTo(sx, 0)
        ctx.lineTo(sx, height)
      }
      for (let gy = startY; (gy - viewOffset.y) * zoom < height; gy++) {
        const sy = Math.round((gy - viewOffset.y) * zoom)
        ctx.moveTo(0, sy)
        ctx.lineTo(width, sy)
      }

      // One stroke() paints all the lines we queued with moveTo/lineTo. Batching
      // into a single path is far cheaper than stroking each line separately.
      ctx.stroke()
    }

    // (track blocks, the curve, tangent handles, control points, and the
    //  coordinate label are layered in here in later milestones — in this
    //  back-to-front draw order so each sits on top of the last.)

    // Ask the browser to call `draw` again before the next repaint (~60fps).
    // Re-assigning `raf` each frame keeps the id current so cleanup cancels
    // the truly-pending frame.
    raf = requestAnimationFrame(draw)
  }

  // Kick off the first frame, then return the cleanup that cancels whatever
  // frame is queued. After this runs, the loop stops dead.
  raf = requestAnimationFrame(draw)
  return () => cancelAnimationFrame(raf)
}
