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
import { store, useStore } from '../core/state'
import { downloadMtrack, openMtrackDialog } from '../core/mtrack'
import { ControlsDialog } from './ControlsDialog'

// Open a .mtrack and load it into the store. Shared shape with the Ctrl+O path in
// input.ts; kept tiny rather than abstracted into the store (file dialogs are app
// glue, not state). A dismissed picker resolves null (no-op); a bad file alerts.
function importTrack() {
  openMtrackDialog()
    .then((points) => {
      if (points) store.getState().loadTrack(points)
    })
    .catch((err: Error) => window.alert(`Couldn't import .mtrack: ${err.message}`))
}

export function ControlPanel() {
  // Drawer open/closed is pure chrome state — it doesn't affect canvas geometry,
  // so it lives in React (not the shared store). Default to open on wide screens,
  // closed on phones so the canvas isn't covered on first load.
  const [open, setOpen] = useState(() => window.innerWidth > 768)
  // The controls/shortcuts modal is pure chrome state too.
  const [helpOpen, setHelpOpen] = useState(false)

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

  // Counts. Selecting `.size` (a number) means this re-renders only when the
  // count actually changes — not on every drag frame, and never reads `points`
  // (CLAUDE rule 2). gridBlocks is derived; highlights only change on user taps.
  const blockCount = useStore((s) => s.gridBlocks.size)
  const placedCount = useStore((s) => s.highlightedBlocks.size)
  const clearHighlights = useStore((s) => s.clearHighlights)

  return (
    <>
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
          {/* Live readouts — the title block reflects real state, not decoration. */}
          <div className="readout">SCALE — {zoomLabel} PX / BLK</div>
          <div className="readout">{blockCount.toLocaleString()} BLOCKS</div>
          {isBuildMode && (
            <div className="readout">{placedCount.toLocaleString()} PLACED</div>
          )}
        </header>

        {/* Width + tangents are curve settings — disabled in build mode (SPEC). */}
        <label className="field">
          <span className="field__label">
            WIDTH <b>{curveWidth}</b>
          </span>
          <input
            type="range"
            min={1}
            max={64}
            step={1}
            value={curveWidth}
            disabled={isBuildMode}
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
          <input
            type="checkbox"
            checked={showTangents}
            onChange={toggleTangents}
            disabled={isBuildMode}
          />
          <span className="field__label">SHOW TANGENTS</span>
        </label>

        <button
          type="button"
          className={`btn${isBuildMode ? ' btn--active' : ''}`}
          onClick={toggleBuildMode}
        >
          {isBuildMode ? 'Exit build mode' : 'Enter build mode'}
        </button>

        {/* Build-mode-only: clear all "placed" highlights (also the R key). */}
        {isBuildMode && (
          <button type="button" className="btn" onClick={clearHighlights}>
            Reset highlight
          </button>
        )}

        {/* Reads points via getState() in the handler — NOT a subscription, so
            this stays off the canvas render path (CLAUDE rule 2). */}
        <button
          type="button"
          className="btn"
          onClick={() => downloadMtrack(store.getState().points)}
        >
          Export .mtrack
        </button>

        <button type="button" className="btn" onClick={importTrack}>
          Import .mtrack
        </button>

        <button type="button" className="btn" onClick={() => setHelpOpen(true)}>
          Controls &amp; shortcuts
        </button>
      </div>
      </aside>

      {helpOpen && <ControlsDialog onClose={() => setHelpOpen(false)} />}
    </>
  )
}
