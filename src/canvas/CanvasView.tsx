// The React component that HOSTS the canvas — but does not draw on it.
//
// Its only jobs: put a <canvas> element in the DOM, size it to its box, and
// start/stop the imperative render loop. All actual painting happens in
// renderer.ts. This is the boundary between React's world (DOM, components)
// and the imperative world (Canvas2D pixels). React owns the chrome, never
// the drawing (CLAUDE.md rule 1).

import { useEffect, useRef } from 'react'
import { startRenderLoop } from './renderer'
import { attachInput } from './input'

export function CanvasView() {
  // A ref is a stable "box" that holds a value across renders without causing
  // re-renders when it changes. We need it to grab the real <canvas> DOM node
  // (to pass to getContext/the renderer). Starts null; React fills it in when
  // the element mounts, via the `ref={ref}` prop below.
  const ref = useRef<HTMLCanvasElement>(null)

  // useEffect runs AFTER the component mounts (the DOM node now exists). The
  // empty dependency array [] means "run once on mount; the returned function
  // runs on unmount." That lifecycle is exactly where imperative setup/teardown
  // belongs.
  useEffect(() => {
    const canvas = ref.current! // guaranteed set: effects run after mount

    // A canvas has TWO sizes: its CSS layout size (how big the box is on
    // screen) and its drawing-buffer size (canvas.width/height, the pixel
    // grid you paint into). They're independent — if you don't set the buffer
    // to match the box, the browser stretches a default 300x150 buffer and
    // everything looks blurry. So we copy the measured box size into the buffer.
    const resize = () => {
      canvas.width = canvas.clientWidth
      canvas.height = canvas.clientHeight
    }
    resize()
    window.addEventListener('resize', resize) // keep buffer matched on window resize

    // Start the imperative loop; it returns its own cleanup (cancels the RAF).
    const stop = startRenderLoop(canvas)

    // Attach pan/zoom input (mouse + touch); also returns its own cleanup that
    // removes every listener it added.
    const detachInput = attachInput(canvas)

    // The cleanup function: React runs this on unmount. Stopping the loop,
    // detaching input, AND removing the resize listener prevents leaks and
    // duplicate loops/handlers — critical under StrictMode, which intentionally
    // mounts→unmounts→remounts in dev to surface exactly this kind of missing
    // cleanup.
    return () => {
      stop()
      detachInput()
      window.removeEventListener('resize', resize)
    }
  }, [])

  // Sizing/position is handled in CSS (`canvas { position: fixed; inset: 0 }`):
  // the canvas is full-bleed and the drawer floats over it.
  return <canvas ref={ref} />
}
