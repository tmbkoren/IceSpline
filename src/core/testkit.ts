// Shared helpers for the differential test and the benchmark. Not a test file
// itself (no vitest imports) — just deterministic curve generation and the
// Node-side loader for the compiled WASM module.

import type { ControlPoint } from './state'
import type { CurveModuleFactory } from './wasm'

/**
 * mulberry32 — a tiny seeded PRNG. We want REPRODUCIBLE random curves: a
 * differential failure must be replayable, and benchmarks must hit identical
 * work each run. Math.random() gives neither. Returns a function yielding
 * floats in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A random track of `n` control points with random relative tangents. */
export function randomTrack(n: number, rng: () => number): ControlPoint[] {
  const span = (k: number) => rng() * k - k / 2 // centered in [-k/2, k/2)
  const points: ControlPoint[] = []
  for (let i = 0; i < n; i++) {
    points.push({
      pos: { x: span(200), y: span(200) },
      inTangent: { x: span(40), y: span(40) },
      outTangent: { x: span(40), y: span(40) },
      mirrored: false,
    })
  }
  return points
}

/**
 * Load the Emscripten factory from the built public/curve.js. The import path
 * is built as a runtime expression (not a string literal) so the type checker
 * doesn't try to resolve the typeless emitted glue — we assert its shape here.
 * Used by Node tests/benches; the browser app will load it from its served URL.
 */
export async function loadCurveFactory(): Promise<CurveModuleFactory> {
  const href = new URL('../../public/curve.js', import.meta.url).href
  const mod = (await import(/* @vite-ignore */ href)) as { default: CurveModuleFactory }
  return mod.default
}
