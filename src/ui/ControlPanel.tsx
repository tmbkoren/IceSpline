// The control panel: pure React "chrome" that floats over the canvas as a
// collapsible slide-in drawer (same pattern on desktop and mobile).
//
// This component renders DOM only — sliders, buttons, labels. It NEVER draws
// to the canvas and NEVER reads `points` (CLAUDE.md rules 1-2). It talks to the
// rest of the app solely through the store, via the `useStore` hook.
//
// The golden rule applied here: every `useStore(...)` call selects the SMALLEST
// slice it needs. Each selector is its own subscription, so this component
// re-renders only when one of these specific scalars changes — not when the
// canvas drags points 60x/second.

import { useState } from 'react'
import { useStore } from '../core/state'

export function ControlPanel() {
  // Drawer open/closed is pure chrome state — it doesn't affect canvas geometry,
  // so it lives in React (not the shared store). Default to open on wide screens,
  // closed on phones so the canvas isn't covered on first load.
  const [open, setOpen] = useState(() => window.innerWidth > 768)

  // Each line below is an independent subscription. `curveWidth` is a number,
  // `setCurveWidth` is a stable function reference (Zustand never recreates it),
  // so selecting the action never causes a re-render on its own.
  const curveWidth = useStore((s) => s.curveWidth)
  const setCurveWidth = useStore((s) => s.setCurveWidth)

  const zoom = useStore((s) => s.zoom)
  const setZoom = useStore((s) => s.setZoom)
  // Wheel/pinch produce fractional zoom; round only for DISPLAY (the slider and
  // store keep the precise value).
  const zoomLabel = Math.round(zoom)

  const showTangents = useStore((s) => s.showTangents)
  const toggleTangents = useStore((s) => s.toggleTangents)

  const isBuildMode = useStore((s) => s.isBuildMode)
  const toggleBuildMode = useStore((s) => s.toggleBuildMode)

  return (
    <aside className={`drawer${open ? ' drawer--open' : ''}`}>
      {/* The tab rides outside the drawer's edge, so it stays on-screen and
          interactive whether the drawer is open or closed. */}
      <button
        type="button"
        className="drawer__tab"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? 'Collapse panel' : 'Open panel'}
      >
        {open ? '‹' : '›'}
      </button>

      {/* `inert` when closed: the off-screen controls can't be focused or
          clicked, so keyboard/AT users don't tab into a hidden panel. */}
      <div className="drawer__body" inert={!open}>
        <header className="title-block">
          <h1 className="wordmark">ICESPLINE</h1>
          <p className="subtitle">ICE-ROAD PATH PLANNER</p>
          {/* Live readout — the title block reflects real state, not decoration. */}
          <div className="readout">SCALE — {zoomLabel} PX / BLK</div>
        </header>

        <label className="field">
          <span className="field__label">
            WIDTH <b>{curveWidth}</b>
          </span>
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

        <label className="field">
          <span className="field__label">
            ZOOM <b>{zoomLabel}</b>
          </span>
          <input
            type="range"
            min={2}
            max={40}
            step={1}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </label>

        <label className="field field--row">
          <input type="checkbox" checked={showTangents} onChange={toggleTangents} />
          <span className="field__label">SHOW TANGENTS</span>
        </label>

        <button
          type="button"
          className={`btn${isBuildMode ? ' btn--active' : ''}`}
          onClick={toggleBuildMode}
        >
          {isBuildMode ? 'Exit build mode' : 'Enter build mode'}
        </button>
      </div>
    </aside>
  )
}
