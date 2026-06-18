// Round-trip test for .litematic export: build the bytes with our exporter, then
// read them back with nucleation's OWN reader and assert the placed blocks survived.
// This is the verification oracle for M9 (no extra dependency — nucleation reads
// what it writes). Also exercises the node-WASM init path (the glue's fs branch).

import { describe, it, expect } from 'vitest'
import { buildLitematic } from './litematic'

// A small block set INCLUDING a negative coordinate — the case where the old
// Python int()-truncation bug (CLAUDE rule 4) would show. Keys are "x,y" (grid),
// already floor'd, and map to Minecraft (x, 0, y). In the app this is the track's
// gridBlocks; here a handful of cells is enough to prove the round-trip.
const BLOCKS = new Set(['0,0', '1,0', '0,1', '-3,-5'])

async function readBack(bytes: Uint8Array) {
  const { default: init, SchematicWrapper } = await import('nucleation')
  await init()
  const schem = new SchematicWrapper()
  schem.from_litematic(bytes)
  return schem
}

describe('litematic export round-trip', () => {
  it('round-trips track blocks as packed_ice (incl. negative coords)', async () => {
    const bytes = await buildLitematic(BLOCKS, 'packed_ice')

    // gzip magic — a .litematic is gzipped NBT.
    expect(bytes[0]).toBe(0x1f)
    expect(bytes[1]).toBe(0x8b)

    const schem = await readBack(bytes)
    expect(schem.get_block_count()).toBe(BLOCKS.size)

    // Blocks are normalized to the schematic origin (min corner -> 0,0,0), so read
    // back at the shifted coords. min over {0,1,0,-3} = -3 (x), {0,0,1,-5} = -5 (y).
    const minX = -3
    const minY = -5
    for (const key of BLOCKS) {
      const comma = key.indexOf(',')
      const x = Number(key.slice(0, comma))
      const y = Number(key.slice(comma + 1))
      expect(schem.get_block(x - minX, 0, y - minY)).toContain('packed_ice')
    }
    // The min corner itself lands exactly at the schematic origin.
    expect(schem.get_block(0, 0, 0)).toContain('packed_ice')
  }, 30_000)

  it('honors the blue_ice choice', async () => {
    const bytes = await buildLitematic(BLOCKS, 'blue_ice')
    const schem = await readBack(bytes)
    expect(schem.get_block(0, 0, 0)).toContain('blue_ice')
  }, 30_000)
})
