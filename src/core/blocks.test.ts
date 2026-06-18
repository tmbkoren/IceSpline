// Unit tests for the TS reference block math.
//
// blocks.ts is the differential-test ORACLE — but an oracle is only trustworthy
// if it's checked against ground truth a human computed by hand. Otherwise the
// later WASM-vs-TS test would just prove both share the same bug. So the first
// test below asserts an exact, hand-verified block set; the rest are invariants.

import { describe, it, expect } from 'vitest'
import { computeBlocks, computeSegmentBlocks } from './blocks'
import type { ControlPoint } from './state'

/** Build a control point at (x,y) with zero tangents (a straight-line anchor). */
function cp(x: number, y: number): ControlPoint {
  return { pos: { x, y }, inTangent: { x: 0, y: 0 }, outTangent: { x: 0, y: 0 }, mirrored: false }
}

describe('computeBlocks', () => {
  it('covers a hand-verified disk for a degenerate (single-point) curve', () => {
    // Both anchors at the origin with zero tangents => all four Bézier control
    // points are (0,0) => every sample is exactly (0,0). With width 2 (radius 1)
    // the covered cells are those whose center (x+0.5, y+0.5) is within 1 of the
    // origin. By hand, the four cells around the origin qualify (corner centers
    // at distance √0.5 ≈ 0.707) and nothing else does (next ring is √2.5 ≈ 1.58).
    const blocks = computeBlocks([cp(0, 0), cp(0, 0)], 2)
    expect(blocks).toEqual(new Set(['0,0', '-1,0', '0,-1', '-1,-1']))
  })

  it('covers a 2-wide strip along a straight horizontal segment', () => {
    // P0=(0,0) -> P1=(20,0), zero tangents => the curve is the x-axis segment.
    // Radius 1 reaches cell centers at y=-0.5 and y=0.5 (rows y=-1 and y=0) but
    // not y=±1.5, so every covered block sits in exactly those two rows.
    const blocks = computeBlocks([cp(0, 0), cp(20, 0)], 2)

    expect(blocks.has('10,0')).toBe(true)
    expect(blocks.has('10,-1')).toBe(true)
    expect(blocks.has('10,1')).toBe(false)
    expect(blocks.has('10,-2')).toBe(false)

    for (const key of blocks) {
      const y = Number(key.split(',')[1])
      expect(y === 0 || y === -1).toBe(true)
    }
  })

  it('returns an empty set for fewer than two control points', () => {
    expect(computeBlocks([], 4).size).toBe(0)
    expect(computeBlocks([cp(0, 0)], 4).size).toBe(0)
  })

  it('equals the single segment for a one-segment track', () => {
    const points = [cp(0, 0), cp(8, 3)]
    const whole = computeBlocks(points, 4)
    const seg = computeSegmentBlocks(points, 4, 0)
    expect(whole).toEqual(seg)
  })
})
