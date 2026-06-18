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

  it('fills a slightly-diagonal straight run with no edge holes', () => {
    // Regression for the disk-union sag: long, gently-diagonal straight segments
    // used to drop 1-block holes on their sides. We verify against an INDEPENDENT
    // oracle — brute-force distance to the full segment — not the differential
    // test (which only proves WASM≡TS). A margin around r dodges ULP differences
    // between the implementation's per-interval accumulation and this full-segment
    // distance: cells comfortably inside (≤ r−ε) MUST be covered (no holes); cells
    // covered must be within (≤ r+ε) (no spill). The razor-thin (r−ε, r+ε) band is
    // exempt — that's where the boundary ambiguity lives, not where holes are.
    const ax = 0, ay = 0, bx = 80, by = 9 // ~6.4° off horizontal
    const width = 5
    const r = width / 2
    const eps = 1e-3
    const rIn2 = (r - eps) * (r - eps)
    const rOut2 = (r + eps) * (r + eps)

    const distToSeg2 = (px: number, py: number): number => {
      const abx = bx - ax, aby = by - ay
      const abLen2 = abx * abx + aby * aby
      let t = abLen2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / abLen2 : 0
      if (t < 0) t = 0
      else if (t > 1) t = 1
      const qx = ax + t * abx, qy = ay + t * aby
      const dx = px - qx, dy = py - qy
      return dx * dx + dy * dy
    }

    const blocks = computeBlocks([cp(ax, ay), cp(bx, by)], width)

    // Completeness: no holes inside the strip.
    for (let x = Math.floor(ax - r) - 2; x <= Math.ceil(bx + r) + 2; x++) {
      for (let y = Math.floor(ay - r) - 2; y <= Math.ceil(by + r) + 2; y++) {
        if (distToSeg2(x + 0.5, y + 0.5) <= rIn2) {
          expect(blocks.has(`${x},${y}`)).toBe(true)
        }
      }
    }
    // Soundness: nothing stamped outside the strip.
    for (const key of blocks) {
      const [x, y] = key.split(',').map(Number)
      expect(distToSeg2(x + 0.5, y + 0.5)).toBeLessThanOrEqual(rOut2)
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
