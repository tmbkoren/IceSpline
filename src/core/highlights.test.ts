// Build-mode highlight logic (store): you can only mark blocks that are on the
// track, clearing empties them, and editing the track prunes highlights that no
// longer sit on the road. Pure store logic — no DOM, no WASM.

import { describe, it, expect, beforeEach } from 'vitest'
import { store } from './state'
import type { ControlPoint } from './state'

const cp = (x: number, y: number): ControlPoint => ({
  pos: { x, y },
  inTangent: { x: 0, y: 0 },
  outTangent: { x: 0, y: 0 },
  mirrored: false,
})

beforeEach(() => {
  store.setState({
    points: [],
    selectedIndex: null,
    curveWidth: 3,
    isBuildMode: false,
    gridBlocks: new Set(),
    highlightedBlocks: new Set(),
    undoStack: [[]],
    redoStack: [],
  })
})

describe('build-mode highlights', () => {
  it('toggles a block that is on the track, and ignores one that is not', () => {
    store.getState().loadTrack([cp(0, 0), cp(20, 0)])
    const onTrack = [...store.getState().gridBlocks][0]

    store.getState().toggleHighlight(onTrack)
    expect(store.getState().highlightedBlocks.has(onTrack)).toBe(true)
    store.getState().toggleHighlight(onTrack)
    expect(store.getState().highlightedBlocks.has(onTrack)).toBe(false)

    // A block far from the road can't be marked placed.
    store.getState().toggleHighlight('9999,9999')
    expect(store.getState().highlightedBlocks.size).toBe(0)
  })

  it('clearHighlights empties the set', () => {
    store.getState().loadTrack([cp(0, 0), cp(20, 0)])
    store.getState().toggleHighlight([...store.getState().gridBlocks][0])
    expect(store.getState().highlightedBlocks.size).toBe(1)
    store.getState().clearHighlights()
    expect(store.getState().highlightedBlocks.size).toBe(0)
  })

  it('prunes highlights that leave the track when it is edited', () => {
    store.getState().loadTrack([cp(0, 0), cp(40, 0)])
    const farKey = [...store.getState().gridBlocks].find((k) => Number(k.split(',')[0]) > 30)!
    store.getState().toggleHighlight(farKey)
    expect(store.getState().highlightedBlocks.has(farKey)).toBe(true)

    // Shrink the road so the far end no longer exists.
    store.getState().movePoint(1, { x: 5, y: 0 }, false)
    expect(store.getState().highlightedBlocks.has(farKey)).toBe(false)
  })
})
