// The differential test (CLAUDE.md rule 6): the WASM core and the TS reference
// must produce IDENTICAL block sets for a battery of random curves and widths.
// This is what lets us trust the C++ — if the two ever disagree, one of them is
// wrong, and the hand-verified golden tests in blocks.test.ts say which side to
// suspect first (the TS oracle is checked there against ground truth).
//
// Sets are compared as sets, not ordered arrays: C++ unordered_set iteration
// order won't match TS insertion order, and it doesn't need to.

import { describe, it, expect, beforeAll } from 'vitest'
import { computeBlocks, computeSegmentBlocks } from './blocks'
import { loadWasmBackend, type BlocksBackend } from './wasm'
import { loadCurveFactory, mulberry32, randomTrack } from './testkit'

let wasm: BlocksBackend

beforeAll(async () => {
  wasm = await loadWasmBackend(await loadCurveFactory())
})

describe('WASM vs TS reference', () => {
  // A spread of node counts and widths, each with its own seed so the cases are
  // independent and reproducible.
  const cases = [
    { seed: 1, n: 2, width: 1 },
    { seed: 2, n: 2, width: 8 },
    { seed: 3, n: 5, width: 3 },
    { seed: 4, n: 10, width: 12 },
    { seed: 5, n: 25, width: 5 },
    { seed: 6, n: 40, width: 25 },
  ]

  for (const { seed, n, width } of cases) {
    it(`whole track agrees (n=${n}, width=${width}, seed=${seed})`, () => {
      const track = randomTrack(n, mulberry32(seed))
      expect(wasm.computeBlocks(track, width)).toEqual(computeBlocks(track, width))
    })
  }

  it('single-segment results agree for every segment of a track', () => {
    const track = randomTrack(12, mulberry32(99))
    for (let seg = 0; seg < track.length - 1; seg++) {
      expect(wasm.computeSegmentBlocks(track, 7, seg)).toEqual(
        computeSegmentBlocks(track, 7, seg),
      )
    }
  })

  it('handles negative coordinates identically (floor, not truncation)', () => {
    // A track squarely in negative space — the case the Python original got
    // wrong with int() truncation. Both backends must floor consistently.
    const track = randomTrack(8, mulberry32(-1234))
    expect(wasm.computeBlocks(track, 9)).toEqual(computeBlocks(track, 9))
  })
})
