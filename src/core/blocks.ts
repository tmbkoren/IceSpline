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

  // 3) Walk the curve as a POLYLINE of steps+1 sample points, and stamp the
  //    CAPSULE between each consecutive pair — i.e. every grid cell whose center
  //    is within r of the line *segment*, not just of the sample points.
  //
  //    Why a capsule, not a per-sample disk: the union of disks sags inward
  //    between samples near the strip edge (perpendicular distance ≈ r), so cells
  //    there fall through the gaps — visible as 1-block holes on the sides of
  //    long, slightly-diagonal runs. Distance-to-segment closes those gaps
  //    exactly: the union of per-interval capsules is precisely the set of cells
  //    within r of the polyline. (B(0) == c0 exactly, so we seed prev from c0.)
  let prevX = c0x
  let prevY = c0y
  for (let i = 1; i <= steps; i++) {
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

    stampCapsule(prevX, prevY, px, py, r, r2, out)
    prevX = px
    prevY = py
  }
}

/**
 * Stamp every grid cell whose center (x+0.5, y+0.5) lies within `r` of the line
 * segment A=(ax,ay) -> B=(bx,by). Squared distances throughout (no sqrt), and the
 * projection/clamp/dot-product order is fixed so the C++ port matches bit-for-bit.
 */
function stampCapsule(
  ax: number, ay: number, bx: number, by: number, r: number, r2: number, out: Set<string>,
): void {
  // Cells outside the segment's bbox (expanded by r) can't be within r.
  const minX = Math.floor(Math.min(ax, bx) - r)
  const maxX = Math.ceil(Math.max(ax, bx) + r)
  const minY = Math.floor(Math.min(ay, by) - r)
  const maxY = Math.ceil(Math.max(ay, by) + r)

  const abx = bx - ax
  const aby = by - ay
  const abLen2 = abx * abx + aby * aby

  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      const cxp = x + 0.5
      const cyp = y + 0.5
      // Project the cell center onto the segment, clamped to [0,1].
      const apx = cxp - ax
      const apy = cyp - ay
      let tt = abLen2 > 0 ? (apx * abx + apy * aby) / abLen2 : 0
      if (tt < 0) tt = 0
      else if (tt > 1) tt = 1
      const qx = ax + tt * abx
      const qy = ay + tt * aby
      const dx = cxp - qx
      const dy = cyp - qy
      if (dx * dx + dy * dy <= r2) {
        out.add(`${x},${y}`)
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
