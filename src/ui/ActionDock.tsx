// A floating action dock: a single round button that expands upward into a
// stack of edit actions (undo / redo / mirror / clear). These are the actions
// that are otherwise keyboard-only — essential on touch, handy on desktop.
//
// Pure React chrome. It selects only scalars/stable actions from the store and
// NEVER the `points` array (CLAUDE.md rules 1-2): `selectedIndex` is the only
// data slice, used to disable Mirror when nothing is selected.

import { useState } from 'react'
import { useStore } from '../core/state'

export function ActionDock() {
  const [open, setOpen] = useState(false)

  const selectedIndex = useStore((s) => s.selectedIndex)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const clearPoints = useStore((s) => s.clearPoints)
  const toggleMirror = useStore((s) => s.toggleMirror)

  const hasSelection = selectedIndex !== null

  return (
    <div className="dock">
      {open && (
        <div className="dock__actions" role="group" aria-label="Edit actions">
          <button type="button" className="dock__btn" onClick={undo}>
            <span aria-hidden="true">↶</span> Undo
          </button>
          <button type="button" className="dock__btn" onClick={redo}>
            <span aria-hidden="true">↷</span> Redo
          </button>
          <button
            type="button"
            className="dock__btn"
            onClick={() => hasSelection && toggleMirror(selectedIndex)}
            disabled={!hasSelection}
            title={hasSelection ? undefined : 'Select a point first'}
          >
            Mirror
          </button>
          <button type="button" className="dock__btn dock__btn--warn" onClick={clearPoints}>
            Clear
          </button>
        </div>
      )}

      <button
        type="button"
        className={`dock__toggle${open ? ' dock__toggle--open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? 'Close actions' : 'Open actions'}
      >
        {open ? '✕' : '⋯'}
      </button>
    </div>
  )
}
