// The Controls dialog: a modal reference for every mouse, keyboard, and touch
// interaction. Pure React chrome — it renders DOM only and never touches the
// canvas or the `points` array (CLAUDE.md rules 1-2).
//
// Closes on the X button, a backdrop click, or Escape. We focus the dialog on
// open so Escape works immediately and keyboard users land inside it.

import { useEffect, useRef } from 'react'

interface Shortcut {
  action: string
  keys: string[] // rendered as <kbd> chips, joined by "+" within a chip group
}

interface Group {
  title: string
  items: Shortcut[]
}

// The single source of truth for what's documented. Keep in sync with input.ts.
const GROUPS: Group[] = [
  {
    title: 'MOUSE',
    items: [
      { action: 'Add point', keys: ['Click empty space'] },
      { action: 'Insert point on the curve', keys: ['Click the curve'] },
      { action: 'Select / move a point', keys: ['Drag a point'] },
      { action: 'Move point, keep handles fixed', keys: ['Shift', 'Drag a point'] },
      { action: 'Reshape a tangent', keys: ['Drag a handle'] },
      { action: 'Delete a point', keys: ['Middle-click a point'] },
      { action: 'Pan', keys: ['Right-drag'] },
      { action: 'Zoom', keys: ['Wheel'] },
    ],
  },
  {
    title: 'KEYBOARD',
    items: [
      { action: 'Toggle mirroring (selected point)', keys: ['M'] },
      { action: 'Toggle tangent handles', keys: ['T'] },
      { action: 'Clear all points', keys: ['C'] },
      { action: 'Undo', keys: ['Ctrl', 'Z'] },
      { action: 'Redo', keys: ['Ctrl', 'Y'] },
    ],
  },
  {
    title: 'TOUCH',
    items: [
      { action: 'Pan', keys: ['One-finger drag'] },
      { action: 'Zoom', keys: ['Two-finger pinch'] },
    ],
  },
]

export function ControlsDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null)

  // Focus the dialog on mount and close on Escape.
  useEffect(() => {
    dialogRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    // Backdrop click closes; clicks inside the panel are stopped so they don't.
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Controls and shortcuts"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal__head">
          <h2 className="modal__title">CONTROLS</h2>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {GROUPS.map((group) => (
          <section className="modal__group" key={group.title}>
            <h3 className="modal__group-title">{group.title}</h3>
            {group.items.map((item) => (
              <div className="shortcut" key={item.action}>
                <span className="shortcut__action">{item.action}</span>
                <span className="shortcut__keys">
                  {item.keys.map((k, i) => (
                    <span key={k}>
                      {i > 0 && ' + '}
                      <kbd>{k}</kbd>
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}
