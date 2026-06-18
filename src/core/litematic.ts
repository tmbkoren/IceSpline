// .litematic export (SPEC M9 — the final milestone; see docs/M9-litematic-export.md).
//
// Exports the whole rasterized track (the store's `gridBlocks`) as a single-layer
// Litematica schematic. The heavy lifting — NBT serialization + gzip + Litematica's
// bit-packed schema — is done by the `nucleation` WASM library (AGPL-3.0; the whole
// app is AGPL as a result — see LICENSE).
//
// The nucleation import is DYNAMIC on purpose: the WASM is ~8 MB, and export is a
// rare, one-shot action. A dynamic import() keeps it in its own lazy chunk so it
// never bloats the initial page load (goal #2: frictionless web access). It loads
// only when the user actually exports.
//
// Coordinate mapping (2D top-down plan -> horizontal Minecraft plane):
//   grid.x -> Minecraft x,  grid.y -> Minecraft z,  single layer at y = 0.
// Block keys in the set are "x,y" with the ints already floor'd (CLAUDE rule 4).
//
// Blocks are NORMALIZED to the schematic's own origin: we subtract the bounding-box
// min corner so the set always starts at (0,0,0). Litematica anchors a placement at
// the schematic origin, so baking the absolute grid coords in would make the build
// appear hundreds of blocks from where the player places it (and force a negative-
// coordinate region). Normalizing makes it land right at the placement anchor.

import type { IceBlock } from './state'

/**
 * Build the gzipped-NBT .litematic bytes for a set of blocks (the track's
 * `gridBlocks`). Pure compute (no DOM), so the round-trip test can call it directly
 * and read the bytes back. Async: it lazily loads + instantiates the nucleation WASM.
 */
export async function buildLitematic(blocks: Set<string>, iceBlock: IceBlock): Promise<Uint8Array> {
  const { default: init, SchematicWrapper } = await import('nucleation')
  await init() // loads + instantiates the WASM (node reads from disk, browser fetches)

  // First pass: find the min corner so we can shift the set to start at (0,0,0).
  let minX = Infinity
  let minY = Infinity
  for (const key of blocks) {
    const comma = key.indexOf(',')
    const x = Number(key.slice(0, comma))
    const y = Number(key.slice(comma + 1))
    if (x < minX) minX = x
    if (y < minY) minY = y
  }

  const schem = new SchematicWrapper()
  const blockName = `minecraft:${iceBlock}`
  for (const key of blocks) {
    const comma = key.indexOf(',')
    const x = Number(key.slice(0, comma))
    const y = Number(key.slice(comma + 1))
    schem.set_block(x - minX, 0, y - minY, blockName) // normalized; grid.y -> MC z
  }
  return schem.to_litematic()
}

/**
 * Build the schematic and trigger a browser download. Mirrors downloadMtrack
 * (core/mtrack.ts): Blob + throwaway <a download>, then revoke the object URL.
 */
export async function downloadLitematic(
  blocks: Set<string>,
  iceBlock: IceBlock,
  filename = 'track.litematic',
): Promise<void> {
  const bytes = await buildLitematic(blocks, iceBlock)
  // Copy into a fresh ArrayBuffer-backed view: the WASM returns a Uint8Array typed
  // over ArrayBufferLike, which BlobPart (wanting a plain ArrayBuffer) rejects.
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
