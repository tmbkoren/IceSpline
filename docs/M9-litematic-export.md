# M9 — `.litematic` Export (spec)

The final milestone (SPEC.md → Build Order #9). Exports the user's **placed** blocks
as a Litematica `.litematic` schematic, downloadable from the browser. This is a
one-way **export** only — there is no `.litematic` import.

This is a focused sub-spec; the master spec is `docs/SPEC.md`. Decisions here were
confirmed with the user 2026-06-18; the dependency choice and its rationale live in
the `m9-litematic-stack-decision` memory.

---

## 1. Objective

Let a user take the ice-road they've laid out in **build mode** and download it as a
`.litematic` file they can paste into a Minecraft world with the Litematica mod.

- **Target user:** a Minecraft player planning an ice road who wants the result as a
  buildable schematic, not just an on-screen plan.
- **In scope:** export the whole rasterized track (`gridBlocks`) as a single-layer
  schematic of packed_ice or blue_ice.
- **Out of scope:** importing `.litematic`; multi-layer / 3D; arbitrary block palettes;
  entities, tile entities, regions beyond one.

> **Decision revised 2026-06-18:** export the WHOLE track (`gridBlocks`), NOT the
> build-mode highlight subset. The highlight is a legacy visual block-counting aid, not
> an export selector — exporting only highlighted cells would yield an incomplete
> schematic. (Supersedes the earlier "placed subset only" call.)

---

## 2. What gets exported

| Decision | Value | Rationale |
|---|---|---|
| Block set | **`gridBlocks`** — the whole rasterized track | The schematic is the entire road, not a subset (see revision note above). |
| Block type | **`minecraft:packed_ice`** (default) or **`minecraft:blue_ice`**, user-toggleable | User chose packed_ice as the default; a toggle lets boat-road builders pick blue_ice (lower friction). |
| Layers | **single Y layer** (`y = 0`) | Ice roads are one block thick. |
| Coordinate map | grid `(x, y)` → Minecraft `(x, 0, y)` i.e. `grid.x → MC x`, `grid.y → MC z` | Top-down 2D plan → horizontal MC plane. |
| Empty track | export is **disabled / no-op** when `blockCount === 0` | No track → nothing to export. |

`gridBlocks` is a `Set<string>` of `"x,y"` keys; the ints are already `floor`ed
(CLAUDE rule 4). Parse each key, `set_block(x, 0, y, …)`.

**Normalize to the schematic origin.** Subtract the bounding-box min corner from
every block so the set starts at `(0,0,0)`: `set_block(x - minX, 0, y - minY, …)`.
Litematica anchors a placement at the schematic origin, so baking absolute grid
coords in makes the build land hundreds of blocks from where the player places it.
This also removes negative coords entirely. (Fixed 2026-06-18 after a user reported
the placement appearing ~500 blocks away.)

**Negative coordinates must round-trip** (rule 4 theme): track blocks can sit at
negative grid coords. The verification test covers a negative-coord case explicitly.

**Orientation note:** Minecraft `+Z` is south; screen `+y` is downward. The exported
road may appear mirrored/rotated relative to the on-screen plan when pasted in-game.
User accepted the mapping as-is ("seems correct"); if it reads mirrored in Litematica,
flipping `grid.y → -z` (or offsetting) is the one knob to revisit — logged, not a
blocker.

---

## 3. The library + pipeline

**Dependency:** `nucleation@0.2.13` (pin exactly — it's pre-1.0, API may shift). A
Rust→WASM schematic engine. **License: AGPL-3.0-only** (accepted; see §6).

**Export pipeline** (in a new `src/core/litematic.ts`):

```ts
// Lazy: only loaded when the user clicks Export, so the ~8.9 MB WASM stays OUT of
// the initial bundle (Vite code-splits the dynamic import automatically).
const { default: init, SchematicWrapper } = await import('nucleation')
await init()                                   // loads + instantiates the WASM
const schem = new SchematicWrapper()           // empty schematic
const block = `minecraft:${iceBlock}`          // 'packed_ice' | 'blue_ice' from store
for (const key of gridBlocks) {
  const [x, y] = key.split(',').map(Number)
  schem.set_block(x, 0, y, block)
}
const bytes: Uint8Array = schem.to_litematic() // serialized + gzipped NBT
// download via Blob + anchor (mirror downloadMtrack in mtrack.ts)
```

Exact symbol names (`init` default export, `SchematicWrapper`, `set_block`,
`to_litematic`) are from `docs/javascript/README.md` of the lib; **verify against the
shipped `nucleation.d.ts`** as the first build step (pre-1.0 drift). The package ships
ESM + types + a `./cdn-loader` entry; `nucleation` (main) exposes the wasm-bindgen
classes, `nucleation/api` is a higher-level surface (we use the low-level main entry).

Download mirrors `downloadMtrack` (`src/core/mtrack.ts`): `new Blob([bytes],
{ type: 'application/octet-stream' })`, throwaway `<a download>`, `revokeObjectURL`.
Default filename `track.litematic`.

---

## 4. UI / wiring

- A **"Export .litematic"** button, **always visible** (it exports the whole track,
  independent of build mode — grouped with the `.mtrack` file ops in
  `ControlPanel.tsx`), **disabled when `blockCount === 0`** (empty track).
- An **ice-block toggle** (packed_ice / blue_ice) shown alongside it, also always
  visible. Backed by store state `iceBlock: 'packed_ice' | 'blue_ice'` (default
  `packed_ice`) + a `setIceBlock` action, selected via a scalar `useStore` selector
  (rule-2-safe). Persisted like the other settings (see build order) so the choice
  sticks across reloads. Not a curve edit → no undo history.
- The handler is `async`: it shows a lightweight "Exporting…" state (the WASM download
  + instantiate has latency on first click), calls the pipeline, triggers download,
  and surfaces any failure via `window.alert` (consistent with the `.mtrack` import
  error path).
- No keyboard shortcut required (Ctrl+S is already `.mtrack` export); optional later.
- Reads `highlightedBlocks` through `store.getState()` in the handler (NOT a
  subscription) — keeps it off the render path (CLAUDE rule 2), same as the existing
  Export `.mtrack` button.

---

## 5. Testing strategy

**Primary: round-trip through Nucleation's own reader** (no extra dependency — user
wants fewer deps). In `src/core/litematic.test.ts`:

1. Build a schematic from a known placed set (incl. a **negative-coord** block and a
   couple adjacent blocks).
2. `to_litematic()` → bytes.
3. Read the bytes back with Nucleation's reader (`SchematicWrapper.from_litematic` /
   `Schematic.open` — confirm the exact read API from `nucleation.d.ts`).
4. Assert: every placed `(x, 0, y)` is `minecraft:packed_ice`, the block count
   matches `placedCount`, and no extra non-air blocks exist.

**Known risk to resolve in the build:** the test runs under Vitest's **node** env and
must instantiate the Nucleation WASM there (`init()` auto-detects node). If node-WASM
init proves flaky under Vitest (it's a bigger, different toolchain than the emcc
`curve.js` the existing diff tests load), fall back to: (a) a pure-bytes assertion
(gzip magic header `1f 8b`, decompresses to NBT with the expected root tags), plus
(b) **manual** verification by opening the file in Litematica once. Decide which once
we see init behave in node.

**Bundle check:** after wiring, build and confirm the `nucleation` chunk is a
SEPARATE lazy chunk (not in the main bundle) and note its gzipped wire size. If the
gzipped size is alarming, that's data for a future "swap to a hand-rolled
prismarine-nbt + pako writer" decision — not a blocker for M9.

---

## 6. Boundaries

**Always:**
- Pin `nucleation@0.2.13` exactly.
- Keep the import **dynamic** (lazy) so it never enters the initial bundle.
- Add an **`AGPL-3.0` `LICENSE` file** to the repo root (the project currently has no
  license file; bundling AGPL code makes the deployed app a combined AGPL work). Set
  `"license": "AGPL-3.0-only"` in `package.json`.
- `floor`ed integer coordinates only (they already are in `highlightedBlocks` keys).

**Ask first:**
- Going beyond the packed_ice/blue_ice toggle — a larger block palette, arbitrary
  block picker, or per-block types.
- Adding a second dependency for verification (user prefers fewer deps).
- Flipping the coordinate orientation (only if it reads wrong in-game).

**Never:**
- Put Nucleation in the initial/eager bundle.
- Tie the export to the build-mode highlight subset — export the whole `gridBlocks`.
- Implement `.litematic` import.

---

## 7. Build order (incremental, pause after each)

1. **Deps + license:** `npm i nucleation@0.2.13` — a regular **dependency** (it's
   loaded at runtime via the dynamic import on export, not a build-time tool). Add
   `LICENSE` (AGPL-3.0) + the `package.json` license field. Verify exact API symbols
   against `nucleation.d.ts`. Confirm it imports under Vite without `Buffer`/init quirks.
2. **State:** add `iceBlock: 'packed_ice' | 'blue_ice'` (default `packed_ice`) +
   `setIceBlock` to the store (`state.ts`), and persist it in `persistence.ts`
   alongside `curveWidth`/`showTangents`/`zoom`/`viewOffset` (validate the value on
   hydrate — untrusted storage).
3. **`src/core/litematic.ts`:** the lazy export pipeline + `downloadLitematic(blocks,
   iceBlock)`.
4. **UI:** "Export .litematic" button + ice-block toggle in `ControlPanel.tsx`
   (always visible, button disabled when `blockCount === 0`) + async/Exporting state
   + error alert.
5. **`src/core/litematic.test.ts`:** round-trip via Nucleation reader (or the
   fallback bytes assertion if node-WASM init is flaky); cover both ice blocks.
6. **Verify:** build → confirm separate lazy chunk + note gzipped size; manual export
   + open in Litematica once as the real-world check.
