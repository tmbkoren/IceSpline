// The imperative draw loop — the NON-React half of the app.
//
// This file never imports React, never calls setState, never re-renders.
// It reads the store directly via store.getState() and paints pixels with
// the raw Canvas2D API, once per animation frame. This is the deliberate
// opposite of the UI: the UI subscribes and re-renders; the canvas polls
// and repaints. Reading `points` here 60x/sec is FREE because there's no
// React in the loop (CLAUDE.md rules 1-3).

import { store } from '../core/state'
import { gridToScreen } from './transform'

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
    const { zoom, viewOffset, points, gridBlocks, highlightedBlocks, selectedIndex, showTangents } =
      store.getState()
    const { width, height } = canvas

    // 1) Clear/paint the background. We repaint the whole canvas each frame
    //    rather than tracking dirty regions — simple, and fine at this scale.
    //    Blueprint ink ground (matches --bg in index.css).
    ctx.fillStyle = '#0d1b2a'
    ctx.fillRect(0, 0, width, height)

    // viewOffset is the grid coord shown at screen pixel (0,0). To convert a
    // grid coord `g` to a screen pixel: (g - viewOffset) * zoom. We start at the
    // first whole grid line at/after the top-left edge and step by 1 grid unit
    // until we march off the right/bottom of the canvas.
    const startX = Math.floor(viewOffset.x)
    const startY = Math.floor(viewOffset.y)

    // Graph-paper grid. `queueLines` queues every vertical + horizontal grid
    // line whose integer grid index passes `keep`, then strokes them in one path
    // (batching is far cheaper than stroking each line separately).
    const queueLines = (keep: (gridIndex: number) => boolean) => {
      ctx.beginPath()
      for (let gx = startX; (gx - viewOffset.x) * zoom < width; gx++) {
        if (!keep(gx)) continue
        const sx = Math.round((gx - viewOffset.x) * zoom) // round → crisp 1px line
        ctx.moveTo(sx, 0)
        ctx.lineTo(sx, height)
      }
      for (let gy = startY; (gy - viewOffset.y) * zoom < height; gy++) {
        if (!keep(gy)) continue
        const sy = Math.round((gy - viewOffset.y) * zoom)
        ctx.moveTo(0, sy)
        ctx.lineTo(width, sy)
      }
      ctx.stroke()
    }

    // 2) Cyan grid on the EMPTY background (graph paper). A second, darker grid
    //    is drawn over the track in step 4b — the opaque ice fill separates the
    //    two, so empty space reads cyan and the track reads dark, each visible
    //    against its own backdrop.
    ctx.lineWidth = 1
    if (zoom > 3) {
      ctx.strokeStyle = 'rgba(95, 211, 240, 0.12)' // faint per-block
      queueLines((g) => g % 16 !== 0)
    }
    ctx.strokeStyle = 'rgba(95, 211, 240, 0.32)' // chunk boundaries (every 16)
    queueLines((g) => g % 16 === 0)

    // 3) Track blocks (the rasterized output). Each key is an "x,y" grid cell;
    //    we snap BOTH edges to whole pixels (round x and x+1 separately) so
    //    adjacent cells share an exact border with no seams or overlap, then
    //    cull anything fully offscreen. fillStyle is set once for the whole set.
    const fillCells = (cells: Set<string>, style: string) => {
      ctx.fillStyle = style
      for (const key of cells) {
        const comma = key.indexOf(',')
        const x = +key.slice(0, comma)
        const y = +key.slice(comma + 1)
        const sx0 = Math.round((x - viewOffset.x) * zoom)
        const sy0 = Math.round((y - viewOffset.y) * zoom)
        const sx1 = Math.round((x + 1 - viewOffset.x) * zoom)
        const sy1 = Math.round((y + 1 - viewOffset.y) * zoom)
        if (sx1 < 0 || sy1 < 0 || sx0 > width || sy0 > height) continue
        ctx.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0)
      }
    }
    fillCells(gridBlocks, '#a0e8ff') // ice blue
    // 4) Highlighted blocks (build mode, M5) — empty until then, but drawn here
    //    to lock in the back-to-front order.
    fillCells(highlightedBlocks, 'rgba(255, 0, 0, 0.4)')

    // 4b) Dark grid OVER the track. Drawn across the whole canvas, but it's only
    //     perceptible where it lands on the light ice — over the dark background
    //     it's ink-on-ink and invisible (the cyan grid from step 2 covers that).
    ctx.lineWidth = 1
    if (zoom > 3) {
      ctx.strokeStyle = 'rgba(13, 27, 42, 0.40)' // faint per-block
      queueLines((g) => g % 16 !== 0)
    }
    ctx.strokeStyle = 'rgba(13, 27, 42, 0.68)' // chunk boundaries (every 16)
    queueLines((g) => g % 16 === 0)

    // 5) Bézier curve overlay — a thin white reference line through the spline.
    //    Canvas's bezierCurveTo draws the exact cubic, so we just feed it the
    //    absolute control points per segment: c1 = p0.pos + p0.outTangent,
    //    c2 = p1.pos + p1.inTangent (tangents are relative offsets).
    if (points.length >= 2) {
      ctx.beginPath()
      const start = gridToScreen(points[0].pos.x, points[0].pos.y, zoom, viewOffset)
      ctx.moveTo(start.x, start.y)
      for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i]
        const p1 = points[i + 1]
        const c1 = gridToScreen(
          p0.pos.x + p0.outTangent.x, p0.pos.y + p0.outTangent.y, zoom, viewOffset,
        )
        const c2 = gridToScreen(
          p1.pos.x + p1.inTangent.x, p1.pos.y + p1.inTangent.y, zoom, viewOffset,
        )
        const end = gridToScreen(p1.pos.x, p1.pos.y, zoom, viewOffset)
        ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y)
      }
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    // 6) Tangent lines + handles (when enabled). A handle sits at anchor +
    //    tangent; we skip zero-length tangents (nothing to grab, and the dot
    //    would just hide the anchor). Colors per SPEC: mirrored = both red,
    //    otherwise in = green, out = blue.
    if (showTangents) {
      for (const p of points) {
        const a = gridToScreen(p.pos.x, p.pos.y, zoom, viewOffset)
        const drawHandle = (tx: number, ty: number, color: string) => {
          if (tx === 0 && ty === 0) return
          const h = gridToScreen(p.pos.x + tx, p.pos.y + ty, zoom, viewOffset)
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(h.x, h.y)
          ctx.strokeStyle = color
          ctx.lineWidth = 1
          ctx.stroke()
          ctx.beginPath()
          ctx.arc(h.x, h.y, 4, 0, Math.PI * 2)
          ctx.fillStyle = color
          ctx.fill()
        }
        const inColor = p.mirrored ? '#ff5a5a' : '#5fe08a'
        const outColor = p.mirrored ? '#ff5a5a' : '#5fa8ff'
        drawHandle(p.inTangent.x, p.inTangent.y, inColor)
        drawHandle(p.outTangent.x, p.outTangent.y, outColor)
      }
    }

    // 7) Control points: red dot, yellow + larger when selected. A dark hairline
    //    keeps them legible on top of the light ice fill.
    for (let i = 0; i < points.length; i++) {
      const s = gridToScreen(points[i].pos.x, points[i].pos.y, zoom, viewOffset)
      const selected = i === selectedIndex
      ctx.beginPath()
      ctx.arc(s.x, s.y, selected ? 7 : 5, 0, Math.PI * 2)
      ctx.fillStyle = selected ? '#ffd54a' : '#ff5a5a'
      ctx.fill()
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(13, 27, 42, 0.85)'
      ctx.stroke()
    }

    // (8: coordinate label — a later polish milestone.)

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
