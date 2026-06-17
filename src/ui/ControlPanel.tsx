// The control panel: pure React "chrome" that floats over the canvas.
//
// This component renders DOM only — sliders, buttons, labels. It NEVER draws
// to the canvas and NEVER reads `points` (CLAUDE.md rules 1-2). It talks to the
// rest of the app solely through the store, via the `useStore` hook.
//
// The golden rule applied here: every `useStore(...)` call selects the SMALLEST
// slice it needs. Each selector is its own subscription, so this component
// re-renders only when one of these specific scalars changes — not when the
// canvas drags points 60x/second.

import { useStore } from '../core/state'

export function ControlPanel() {
  // Each line below is an independent subscription. `curveWidth` is a number,
  // `setCurveWidth` is a stable function reference (Zustand never recreates it),
  // so selecting the action never causes a re-render on its own.
  const curveWidth = useStore((s) => s.curveWidth)
  const setCurveWidth = useStore((s) => s.setCurveWidth)

  const zoom = useStore((s) => s.zoom)
  const setZoom = useStore((s) => s.setZoom)

  const showTangents = useStore((s) => s.showTangents)
  const toggleTangents = useStore((s) => s.toggleTangents)

  const isBuildMode = useStore((s) => s.isBuildMode)
  const toggleBuildMode = useStore((s) => s.toggleBuildMode)

  return (
    <aside className="control-panel">
      <h1>IceSpline</h1>

      <label>
        Curve width: {curveWidth}
        <input
          type="range"
          min={1}
          max={16}
          step={1}
          value={curveWidth}
          // e.target.value is always a string from the DOM, so Number() it.
          onChange={(e) => setCurveWidth(Number(e.target.value))}
        />
      </label>

      <label>
        Zoom: {zoom} px/unit
        <input
          type="range"
          min={2}
          max={40}
          step={1}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
        />
      </label>

      <label>
        <input
          type="checkbox"
          checked={showTangents}
          onChange={toggleTangents}
        />
        Show tangents
      </label>

      <button type="button" onClick={toggleBuildMode}>
        {isBuildMode ? 'Exit build mode' : 'Enter build mode'}
      </button>
    </aside>
  )
}
