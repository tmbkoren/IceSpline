// The JS <-> WASM boundary: turn the C ABI in wasm/curve.cpp into the same
// Set<string> API that blocks.ts exposes, so callers don't care which backend
// they got. This is the only file that touches raw linear memory.
//
// Three footguns live here, all from the C side speaking pointers + flat number
// buffers, not objects:
//   1. We malloc input/output buffers ONCE and reuse them (growing on demand),
//      not per call — allocation churn would dwarf the compute.
//   2. ALLOW_MEMORY_GROWTH means a _malloc can DETACH and replace the heap's
//      ArrayBuffer. Any HEAPF64/HEAP32 view grabbed before that malloc is then
//      stale. Rule: do every malloc first, then grab the views, then use them.
//   3. compute_blocks returns -1 when out_blocks was too small. We grow and
//      retry rather than guessing a huge buffer up front.

import type { ControlPoint } from './state'

/** The same surface as blocks.ts — a drop-in compute backend. */
export interface BlocksBackend {
  computeBlocks(points: ControlPoint[], width: number): Set<string>
  computeSegmentBlocks(points: ControlPoint[], width: number, segIndex: number): Set<string>
}

/** The slice of the Emscripten module instance we rely on. */
interface CurveModule {
  _malloc(bytes: number): number
  _free(ptr: number): void
  _compute_blocks(
    pointsPtr: number,
    nPoints: number,
    width: number,
    outPtr: number,
    maxPairs: number,
  ): number
  _compute_segment_blocks(
    pointsPtr: number,
    nPoints: number,
    width: number,
    segIndex: number,
    outPtr: number,
    maxPairs: number,
  ): number
  // Re-read these fresh after any _malloc; growth may have replaced the buffer.
  HEAPF64: Float64Array
  HEAP32: Int32Array
}

/** Emscripten's MODULARIZE factory: `curve.js` default-exports one of these. */
export type CurveModuleFactory = (options?: Record<string, unknown>) => Promise<CurveModule>

/**
 * Instantiate the module and wrap it in a BlocksBackend. Pass the factory the
 * caller imported — keeping the import out of here lets the same code load in
 * the browser (dynamic import of the served /curve.js) and in Node tests
 * (relative import of public/curve.js) without env-specific branching.
 */
export async function loadWasmBackend(factory: CurveModuleFactory): Promise<BlocksBackend> {
  const mod = await factory()

  // Persistent buffers. Capacities track how much we've allocated so we only
  // re-malloc when a call needs more than we already have.
  let inPtr = 0
  let inCapDoubles = 0
  let outPtr = 0
  let outCapInts = 0

  const ensureIn = (doubles: number) => {
    if (doubles <= inCapDoubles) return
    if (inPtr) mod._free(inPtr)
    inPtr = mod._malloc(doubles * 8) // 8 bytes per f64
    inCapDoubles = doubles
  }
  const ensureOut = (ints: number) => {
    if (ints <= outCapInts) return
    if (outPtr) mod._free(outPtr)
    outPtr = mod._malloc(ints * 4) // 4 bytes per i32
    outCapInts = ints
  }

  // Shared core: flatten points -> call `invoke` -> read pairs back as a Set.
  // `invoke(maxPairs)` runs the chosen C function and returns its pair count
  // (or -1). Everything else (buffers, growth/retry, decode) is identical for
  // the whole-track and single-segment entry points.
  const run = (
    points: ControlPoint[],
    invoke: (maxPairs: number) => number,
  ): Set<string> => {
    const n = points.length
    if (n < 2) return new Set()

    // Allocate BOTH buffers before touching any heap view (footgun #2). Start
    // the output at whatever we already have, or a modest default.
    ensureIn(n * 6)
    let maxPairs = outCapInts > 0 ? outCapInts / 2 : 4096
    ensureOut(maxPairs * 2)

    // Now grab the (possibly new) view and write the flat point buffer:
    // [pos.x, pos.y, in.x, in.y, out.x, out.y] per control point.
    const f64 = mod.HEAPF64
    const base = inPtr / 8 // byte offset -> f64 index
    for (let i = 0; i < n; i++) {
      const p = points[i]
      const o = base + i * 6
      f64[o] = p.pos.x
      f64[o + 1] = p.pos.y
      f64[o + 2] = p.inTangent.x
      f64[o + 3] = p.inTangent.y
      f64[o + 4] = p.outTangent.x
      f64[o + 5] = p.outTangent.y
    }

    // Call; on -1 the buffer was too small — quadruple and retry. Growth here
    // preserves already-written linear memory, so we don't rewrite the input.
    let count = invoke(maxPairs)
    while (count === -1) {
      maxPairs *= 4
      ensureOut(maxPairs * 2)
      count = invoke(maxPairs)
    }

    // Re-grab HEAP32 after the last possible malloc, then decode [x,y] pairs.
    const i32 = mod.HEAP32
    const ob = outPtr / 4 // byte offset -> i32 index
    const out = new Set<string>()
    for (let k = 0; k < count; k++) {
      const x = i32[ob + k * 2]
      const y = i32[ob + k * 2 + 1]
      out.add(`${x},${y}`)
    }
    return out
  }

  return {
    computeBlocks(points, width) {
      return run(points, (maxPairs) =>
        mod._compute_blocks(inPtr, points.length, width, outPtr, maxPairs),
      )
    },
    computeSegmentBlocks(points, width, segIndex) {
      return run(points, (maxPairs) =>
        mod._compute_segment_blocks(inPtr, points.length, width, segIndex, outPtr, maxPairs),
      )
    },
  }
}
