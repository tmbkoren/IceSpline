// Guards the one nontrivial new algorithm in Milestone 3: inserting a point on
// the curve via de Casteljau subdivision (state.ts -> insertPoint). The whole
// promise of de Casteljau is that the split is EXACT — the two sub-cubics
// together trace the identical curve. We verify that directly: sample the
// original cubic, then sample the two halves the split produced, and assert they
// reproduce the original at the remapped parameters.
//
// No WASM needed — this exercises pure store logic against a math identity.

import { describe, it, expect } from 'vitest'
import { store } from './state'
import type { ControlPoint, Vec2 } from './state'

const cp = (pos: Vec2, inT: Vec2, outT: Vec2): ControlPoint => ({
  pos,
  inTangent: inT,
  outTangent: outT,
  mirrored: false,
})

// Evaluate the cubic for segment [a, b] at parameter t, using the same absolute
// control points the renderer/rasterizer use (tangents are relative offsets).
function evalSeg(a: ControlPoint, b: ControlPoint, t: number): Vec2 {
  const c0 = a.pos
  const c1 = { x: a.pos.x + a.outTangent.x, y: a.pos.y + a.outTangent.y }
  const c2 = { x: b.pos.x + b.inTangent.x, y: b.pos.y + b.inTangent.y }
  const c3 = b.pos
  const u = 1 - t
  const b0 = u * u * u
  const b1 = 3 * u * u * t
  const b2 = 3 * u * t * t
  const b3 = t * t * t
  return {
    x: b0 * c0.x + b1 * c1.x + b2 * c2.x + b3 * c3.x,
    y: b0 * c0.y + b1 * c1.y + b2 * c2.y + b3 * c3.y,
  }
}

describe('insertPoint — de Casteljau split is exact', () => {
  it('the two sub-cubics reproduce the original curve', () => {
    // An asymmetric S-ish curve so the test isn't accidentally satisfied by
    // symmetry.
    const a = cp({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 12, y: 34 })
    const b = cp({ x: 40, y: 5 }, { x: -18, y: 22 }, { x: 0, y: 0 })

    store.setState({
      points: [a, b],
      selectedIndex: null,
      undoStack: [[]],
      redoStack: [],
      gridBlocks: new Set(),
    })

    const tSplit = 0.4
    const orig = (t: number) => evalSeg(a, b, t)
    store.getState().insertPoint(0, tSplit)

    const pts = store.getState().points
    expect(pts.length).toBe(3)
    const [left, mid, right] = pts

    // The new anchor lands exactly on the original curve at tSplit.
    const f = orig(tSplit)
    expect(mid.pos.x).toBeCloseTo(f.x, 9)
    expect(mid.pos.y).toBeCloseTo(f.y, 9)

    // Left half [0,1] === original [0, tSplit]; right half === original [tSplit,1].
    for (const u of [0, 0.2, 0.5, 0.8, 1]) {
      const l = evalSeg(left, mid, u)
      const expectedL = orig(u * tSplit)
      expect(l.x).toBeCloseTo(expectedL.x, 9)
      expect(l.y).toBeCloseTo(expectedL.y, 9)

      const r = evalSeg(mid, right, u)
      const expectedR = orig(tSplit + u * (1 - tSplit))
      expect(r.x).toBeCloseTo(expectedR.x, 9)
      expect(r.y).toBeCloseTo(expectedR.y, 9)
    }
  })

  it('records one undo step and is reversible', () => {
    const a = cp({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 10 })
    const b = cp({ x: 20, y: 0 }, { x: -10, y: 10 }, { x: 0, y: 0 })
    store.setState({
      points: [a, b],
      selectedIndex: null,
      undoStack: [clone([a, b])],
      redoStack: [],
      gridBlocks: new Set(),
    })

    store.getState().insertPoint(0, 0.5)
    expect(store.getState().points.length).toBe(3)

    store.getState().undo()
    expect(store.getState().points.length).toBe(2)
  })
})

function clone(pts: ControlPoint[]): ControlPoint[] {
  return pts.map((p) => ({
    pos: { ...p.pos },
    inTangent: { ...p.inTangent },
    outTangent: { ...p.outTangent },
    mirrored: p.mirrored,
  }))
}
