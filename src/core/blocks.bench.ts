// Performance comparison: WASM core vs the pure-TS reference, same inputs.
//
// Run with `npm run bench`. Vitest's `bench` runs each function many times and
// reports ops/sec (higher = faster) with relative speed. We bench a few track
// sizes because the WASM/JS tradeoff shifts with workload: tiny curves are
// dominated by the JS<->WASM call + buffer copy overhead (where plain TS can
// win), while large curves are dominated by the inner rasterization loop (where
// WASM should pull ahead). Seeing both is the point.
//
// NOTE: this measures full-track recompute. The app's hot path is per-segment
// incremental recompute (compute_segment_blocks), so treat these as a ceiling
// on per-edit cost, not the per-frame cost.

import { bench, describe, beforeAll } from 'vitest'
import { computeBlocks as tsComputeBlocks } from './blocks'
import { loadWasmBackend, type BlocksBackend } from './wasm'
import { loadCurveFactory, mulberry32, randomTrack } from './testkit'

let wasm: BlocksBackend

beforeAll(async () => {
  wasm = await loadWasmBackend(await loadCurveFactory())
})

// Fixed seed per size => identical work for both backends, reproducible runs.
const sizes = [
  { label: 'small (3 nodes)', n: 3, width: 5 },
  { label: 'medium (25 nodes)', n: 25, width: 12 },
  { label: 'large (100 nodes)', n: 100, width: 25 },
]

for (const { label, n, width } of sizes) {
  const track = randomTrack(n, mulberry32(n * 1000 + width))
  describe(`compute_blocks — ${label}, width ${width}`, () => {
    bench('TypeScript', () => {
      tsComputeBlocks(track, width)
    })
    bench('WASM', () => {
      wasm.computeBlocks(track, width)
    })
  })
}
