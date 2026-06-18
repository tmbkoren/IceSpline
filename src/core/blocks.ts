// The TypeScript reference implementation of the block math (CLAUDE.md rule 6).
//
// This file is the SPEC made executable. It does exactly what wasm/curve.cpp
// will do — given the spline's control points and a width, work out which
// integer grid cells the road covers. It serves two jobs:
//   1. the differential-test ORACLE — Vitest feeds the same curves to this and
//      to the compiled WASM and asserts the two produce identical block sets;
//   2. a FALLBACK if the WASM module ever fails to load.
//
// CRITICAL — keep this byte-for-byte portable to C++. The differential test only
// works because IEEE-754 binary64 math is bit-identical across JS and WASM *when
// the operations and their order match*. To preserve that, this file obeys three
// rules the C++ port must mirror exactly:
//   • distance is compared as SQUARED distance (dx*dx + dy*dy <= r*r). Never
//     Math.hypot — it uses a scaled algorithm that won't match sqrt(dx²+dy²).
//   • Bézier terms use explicit multiplication (t*t*t), never Math.pow — pow is
//     not correctly-rounded and differs JS vs C++.
//   • summations (chord length, basis terms) happen in a fixed, matching order.

import type { ControlPoint } from './state'

/**
 * All integer blocks the whole track occupies: the deduplicated union of every
 * segment's blocks. Returns a Set of "x,y" string keys (the store's block key
 * format), so set-union and membership are O(1) and dedup is automatic.
 *
 * A track of N control points has N-1 segments. Fewer than 2 points => no
 * segments => empty set.
 */
export function computeBlocks(points: ControlPoint[], width: number): Set<string> {
  const out = new Set<string>()
  for (let seg = 0; seg < points.length - 1; seg++) {
    addSegmentBlocks(points, width, seg, out)
  }
  return out
}

/**
 * The blocks for a single segment [segIndex, segIndex+1]. This is the per-frame
 * drag path later (recompute one segment, not the whole track). Returns its own
 * Set; the union in computeBlocks is built by `addSegmentBlocks` writing into a
 * shared set instead, to avoid allocating a Set per segment.
 */
export function computeSegmentBlocks(
  points: ControlPoint[],
  width: number,
  segIndex: number,
): Set<string> {
  const out = new Set<string>()
  addSegmentBlocks(points, width, segIndex, out)
  return out
}

/**
 * The core algorithm (SPEC "Algorithm (per segment [i, i+1])"). Writes every
 * covered block into `out`. Splitting it out lets computeBlocks union all
 * segments into one set without intermediate allocations.
 */
function addSegmentBlocks(
  points: ControlPoint[],
  width: number,
  segIndex: number,
  out: Set<string>,
): void {
  const p0 = points[segIndex]
  const p1 = points[segIndex + 1]

  // 1) Absolute Bézier control points. Tangents are stored as RELATIVE offsets
  //    from each anchor's pos, so add them to recover absolute handle positions.
  //    The cubic's four control points are: p0.pos, p1abs, p2abs, p1.pos.
  const c0x = p0.pos.x
  const c0y = p0.pos.y
  const c1x = p0.pos.x + p0.outTangent.x
  const c1y = p0.pos.y + p0.outTangent.y
  const c2x = p1.pos.x + p1.inTangent.x
  const c2y = p1.pos.y + p1.inTangent.y
  const c3x = p1.pos.x
  const c3y = p1.pos.y

  // 2) Step count from the control polygon's chord length: longer curves get
  //    more samples. Summation order is fixed (c0->c1, c1->c2, c2->c3) so the
  //    C++ port computes the identical float and thus the identical step count —
  //    a one-off difference here would rewrite the whole block set.
  const chordLength = dist(c0x, c0y, c1x, c1y) + dist(c1x, c1y, c2x, c2y) + dist(c2x, c2y, c3x, c3y)
  const half = Math.floor(chordLength / 2)
  const steps = half > 20 ? half : 20

  const r = width / 2.0
  const r2 = r * r

  // 3) Walk the curve at steps+1 sample points (t = 0 .. 1 inclusive). For each
  //    sample, stamp every grid cell whose CENTER (x+0.5, y+0.5) lies within r
  //    of the sample. Dedup is free — `out` is a Set.
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const u = 1 - t

    // Cubic Bézier basis, expanded into explicit multiplications (no Math.pow).
    // B(t) = u³·c0 + 3u²t·c1 + 3ut²·c2 + t³·c3
    const b0 = u * u * u
    const b1 = 3 * u * u * t
    const b2 = 3 * u * t * t
    const b3 = t * t * t
    const px = b0 * c0x + b1 * c1x + b2 * c2x + b3 * c3x
    const py = b0 * c0y + b1 * c1y + b2 * c2y + b3 * c3y

    // Only the cells in the sample's bounding box can be within r; test each.
    const minX = Math.floor(px - r)
    const maxX = Math.ceil(px + r)
    const minY = Math.floor(py - r)
    const maxY = Math.ceil(py + r)
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const dx = x + 0.5 - px
        const dy = y + 0.5 - py
        if (dx * dx + dy * dy <= r2) {
          out.add(`${x},${y}`)
        }
      }
    }
  }
}

/** Euclidean distance via sqrt(dx²+dy²) — matches C++ std::sqrt exactly. */
function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  return Math.sqrt(dx * dx + dy * dy)
}
