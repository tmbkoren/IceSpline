# IceSpline — Specification

Web tool for planning Minecraft **ice-road paths** with cubic Bézier splines:
draw a smooth curve through control points and it rasterizes onto the block grid,
ready to build. (Under the hood it's a general curve-to-blocks generator — ice
roads are the flagship and focus.) A C++ core compiled to WebAssembly handles all
Bézier math and block rasterization. A React + TypeScript frontend handles state,
rendering via the Canvas 2D API, and user interaction.

---

## Goals (these decide trade-offs)

1. **Performance.** The original recomputes the entire block set on every
   mouse-move frame in interpreted CPython. The rewrite must stay at 60fps while
   dragging, on realistic tracks (dozens of control points, thousands of blocks).
2. **Frictionless web access.** It runs in a browser with nothing to download or
   install. Static hosting, no server.

Where a choice trades one off against the other, performance during interaction
wins, because that is the felt experience of the tool.

> **On WASM and performance:** the dominant performance win is *leaving CPython
> for the browser* — V8 is 10–100× faster than CPython on this workload — plus
> the algorithmic changes in the **Performance** section below (incremental
> recompute, frame throttling). The C++/WASM core is a deliberate part of this
> project's stack, but it is **not** what delivers the speedup; an O(whole-track)
> algorithm is slow in any language. Feed the WASM core the incremental algorithm
> or the performance goal is missed regardless of the language.

---

## Technology Stack (definitive)

| Layer | Choice | Notes |
|---|---|---|
| Compute core | **C++ → WebAssembly** via Emscripten (`emcc`) | Pure computation; no DOM/state/I/O |
| Language (frontend) | **TypeScript** | Strict mode on |
| UI framework | **React 18** | Owns the DOM chrome only — see rule below |
| Build / dev server | **Vite** | HMR, TS, easy WASM + static output |
| State | **Zustand** | Subscribable outside React for the canvas loop |
| Rendering | **Canvas 2D API** | Imperative, framework-free |
| Tests | **Vitest** | Unit tests + WASM-vs-TS differential tests |
| Hosting | **GitHub Pages** | Static; deployed via GitHub Actions |
| CI/CD | **GitHub Actions** | Compile WASM → Vite build → deploy. See `DEPLOYMENT.md` |

### The cardinal rule: React owns the chrome, not the canvas

- **React** renders everything that *is* a DOM tree: control panel, dialogs,
  menus, the keybinds modal, labels.
- The **canvas** is an imperative escape hatch. Render the `<canvas>` once via a
  component, grab it with a `ref`, and draw directly with `ctx.*` calls inside a
  `requestAnimationFrame` loop. Canvas drawing never goes through React's
  reconciler.
- Mouse handlers on the canvas mutate app state and request a redraw — they do
  **not** call `setState` per frame. Routing per-frame canvas updates through
  React state would re-render 60×/second for a DOM that didn't change; that is
  the one failure mode to avoid.
- The RAF redraw must read the *latest* state via `getState()`/a ref or a store
  subscription, not a captured closure, or it will chase stale state.
- Under React 18 StrictMode (dev), effects double-invoke — the canvas setup
  effect must clean up (cancel the RAF, remove listeners) so the double-mount
  doesn't stack two loops.

---

## Architecture

```
Browser
├── React + TypeScript
│   ├── core/        framework-free: WASM wrapper, curve math, state store, file I/O
│   ├── canvas/      <canvas> component + imperative renderer (Canvas 2D, RAF loop)
│   └── ui/          React components: control panel, dialogs, labels
│
└── WASM Module (C++)
    └── compute_blocks / compute_segment_blocks  (pure functions)
```

The WASM module is **pure computation** — no I/O, no DOM, no state. The `core/`
layer (plain TS) owns all state and calls into WASM whenever it needs blocks
recomputed. React sits on top as a thin shell; keeping `core/` framework-free
keeps the WASM boundary and curve math testable and portable.

---

## Performance

This is a goal, not a nice-to-have. Three requirements:

### 1. Incremental recompute
The original rebuilds the whole track's block set on every change. Don't.
A track is a chain of segments; dragging control point `i` changes only segments
`[i-1, i]` and `[i, i+1]`. So:

- Keep a **per-segment block set** in `core/` (one `Set<string>` per segment, or
  the raw block array the WASM call returns).
- On a point drag, recompute only the ≤2 affected segments via
  `compute_segment_blocks`, then rebuild the union `gridBlocks` from the cached
  per-segment sets.
- A **width change** invalidates all segments (recompute all).
- Adding/inserting/deleting a point invalidates its neighbours' segments.

This turns per-frame work from O(whole track) into O(local), which is the actual
fix. The WASM/JS choice is secondary to this.

### 2. Throttle to the frame
Coalesce `pointermove` events: update state immediately, but schedule recompute
+ repaint once per `requestAnimationFrame`. `pointermove` can fire faster than
60Hz; never recompute more than once per painted frame.

### 3. Render only what's visible
When drawing `gridBlocks`/`highlightedBlocks`, cull blocks outside the current
viewport before issuing `ctx.fillRect`. (The original already intersect-tests
each block against the canvas rect; keep that.)

**Targets:** sustained 60fps dragging a point on a track of ~50 control points /
~10k blocks at width 25; first paint after load < 1s on a cold cache.

---

## WASM Module

### Responsibility
Given Bézier control points and a width, return the set of integer grid block
coordinates the track occupies — either for the whole track or for one segment.

### Algorithm (per segment `[i, i+1]`)
1. Absolute handle positions: `p1_abs = p0.pos + p0.out_tangent`,
   `p2_abs = p1.pos + p1.in_tangent` (tangents are relative offsets from `pos`).
2. Sample the cubic Bézier at `max(20, floor(chord_length / 2))` steps, where
   `chord_length = |p0.pos→p1_abs| + |p1_abs→p2_abs| + |p2_abs→p1.pos|`. This
   yields `steps + 1` sample points — treat them as a **polyline**.
3. For each consecutive pair of samples, stamp the **capsule** between them:
   collect every integer grid cell `(x, y)` whose center `(x + 0.5, y + 0.5)` is
   within `width / 2.0` of the line *segment* (distance-to-segment, with the
   projection parameter clamped to `[0, 1]`). Iterate the cells in the segment's
   bounding box expanded by `r` and distance-test each.
4. Deduplicate within the segment.

The full-track result is the union of all segments' sets (deduplicated).

> **Why capsules, not per-sample disks.** Stamping a filled disk at each *sample
> point* leaves the strip incomplete: near the strip edge (perpendicular distance
> ≈ `r`) the union of disks sags inward between samples, dropping 1-block holes on
> the sides of long, slightly-diagonal runs — no finite sample spacing fixes it.
> The union of per-interval **capsules** is exactly the set of cells within `r` of
> the polyline, so there are no gaps. Use squared distances throughout (no
> `hypot`/`sqrt` in the test) and keep the projection/clamp/dot-product order
> identical in `blocks.ts` and `curve.cpp` so the differential test stays
> bit-exact. (Cost: overlapping per-interval bounding boxes re-test shared cells —
> addressed by the performance milestone's per-segment caching, not here.)

### Block coordinate convention
A grid point maps to a block with **`floor`**, never truncation:
`block = (floor(grid.x), floor(grid.y))`. This applies in the fill, in hit-tests,
and in the coordinate label. (The Python original used `int()` in spots, which
truncates toward zero and misaligns blocks at negative coordinates — a latent
bug this rewrite fixes. Don't reintroduce it.)

### C API (Emscripten `extern "C"`)

```cpp
// points: flat array, 6 doubles per control point:
//   [pos.x, pos.y, in_tangent.x, in_tangent.y, out_tangent.x, out_tangent.y]
//   tangents are RELATIVE offsets from pos (not absolute positions)
// width: track width in grid blocks
// out_blocks: caller-allocated output, flat [x0, y0, x1, y1, ...]
// max_pairs: capacity of out_blocks in (x,y) pairs
// returns: number of (x,y) pairs written, or -1 if the buffer was too small

// Whole track (initial load, width change, import):
int compute_blocks(
    const double* points, int n_points, double width,
    int* out_blocks, int max_pairs);

// One segment [seg, seg+1] (the per-frame drag path):
int compute_segment_blocks(
    const double* points, int n_points, double width, int seg_index,
    int* out_blocks, int max_pairs);
```

Dedup inside C++ with an `unordered_set` keyed by a packed 64-bit integer,
`key = ((int64_t)x << 32) ^ (uint32_t)y`, rather than hashing a pair type.

### Memory / calling convention
- TS pre-allocates input and output buffers in WASM linear memory via
  `Module._malloc` once at startup and reuses them across calls.
- TS writes points with `Module.HEAPF64`, reads output with `Module.HEAP32`.
- Output buffer sized generously (e.g. 1M pairs). On a `-1` return, grow the
  buffer and retry.
- WASM is an ES module: `emcc -s EXPORT_ES6=1 -s MODULARIZE=1`.

### TS reference implementation (required)
`core/` also contains a pure-TS implementation of the same block math. It is:
- the **differential-test oracle** — Vitest asserts WASM and TS produce identical
  block sets for a battery of curves/widths;
- a **fallback** if WASM fails to load.

Keep the two in lockstep; the TS version is the spec made executable.

---

## Frontend State

```typescript
interface Vec2 { x: number; y: number; }

interface ControlPoint {
  pos: Vec2;
  inTangent:  Vec2;   // relative offset from pos
  outTangent: Vec2;   // relative offset from pos
  mirrored: boolean;
}

interface AppState {
  points: ControlPoint[];
  selectedIndex: number | null;
  curveWidth: number;            // 1–25 blocks, default 3
  showTangents: boolean;         // default true
  isBuildMode: boolean;          // default false (Design)
  gridBlocks: Set<string>;       // "x,y" keys — union of per-segment sets
  highlightedBlocks: Set<string>;
  zoom: number;                  // 2–40 px/block, default 10
  viewOffset: Vec2;              // top-left grid coordinate visible
  undoStack: ControlPoint[][];   // max 50 entries
  redoStack: ControlPoint[][];
}
```

- `gridBlocks` is **derived**, never stored in undo history — only `points` is.
  It is rebuilt from the per-segment caches (see Performance).
- Seed `undoStack` with one baseline snapshot at startup; undo is a no-op unless
  `undoStack.length > 1`. A snapshot is pushed when an edit *commits* (pointer-up,
  or a discrete action like insert/delete/clear/mirror/import) — not per drag
  frame.

---

## Control Panel ↔ Canvas: the Shared Store

The control panel (React) changes canvas state — width, mode, tangent visibility
— yet the cardinal rule keeps React out of the draw loop. These don't conflict,
because there are two distinct kinds of interaction:

| Kind | Frequency | Path | Examples |
|---|---|---|---|
| **Discrete settings** | Rare, event-driven | React → store → canvas ✅ | width, mode, tangents toggle |
| **Per-frame drawing** | 60×/second | store → canvas, React not involved | redraw, dragging a point |

### The store is the bridge

A single Zustand store sits between React and the canvas. Both talk to it; they
never call each other directly.

```
React control panel  ──writes──▶   STORE   ──read by──▶  canvas RAF loop
   (slider onChange)              (Zustand)              (renderer)
```

- **React → store**: the control panel writes settings on user events (ordinary
  controlled inputs).
- **store → canvas**: the renderer *reads* the store outside React via
  `subscribe`/`getState`, which do **not** trigger React renders.
- **Footgun:** no mounted React component may select the `points` array
  (`useStore(s => s.points)`) — that re-renders React on every drag frame. Point
  geometry reaches the canvas only through `subscribe`/`getState`.

### Recompute vs. repaint

Decide *what* changed inside the `subscribe` callback:

- **Geometry-affecting** (a point moved, width changed) → recompute the affected
  segments via WASM, rebuild `gridBlocks`, then repaint.
- **Render-only** (mode, tangent visibility, zoom, pan) → just set the redraw
  flag; no WASM call.

This is why Zustand over a plain `useReducer`: `getState()`/`subscribe()` let
React and the canvas share one source of truth while staying on opposite sides of
the render boundary. A reducer lives inside React and can't be read from the RAF
loop without threading refs everywhere.

---

## Coordinate System

| Space | Type | Description |
|---|---|---|
| Screen | integer pixels | Canvas element coordinates |
| Grid | float | World coordinates; one unit = one Minecraft block |
| Block | integer pair | `(floor(grid.x), floor(grid.y))` — always `floor` |

Conversions:
```
grid.x = screen.x / zoom + viewOffset.x
grid.y = screen.y / zoom + viewOffset.y

screen.x = (grid.x - viewOffset.x) * zoom
screen.y = (grid.y - viewOffset.y) * zoom
```

Grid blocks render as `zoom × zoom` pixel squares. The coordinate label shows
`(floor(grid.x), floor(grid.y))`.

---

## Features

### Design Mode — Editing

| Action | Trigger | Detail |
|---|---|---|
| Add point | Left-click empty space | Appends to the endpoint nearest the click |
| Insert point on curve | Left-click within threshold of curve | Tangent split (see note) |
| Move point | Left-drag control point | |
| Move point, fix tangents | Shift + left-drag control point | Tangent absolute world positions held constant |
| Drag in-tangent | Left-drag in-handle | If `mirrored`, out-tangent mirrors |
| Drag out-tangent | Left-drag out-handle | If `mirrored`, in-tangent mirrors |
| Delete point | Middle-click control point | |
| Clear all | `C` key | Saves to undo history |
| Toggle tangent mirroring | `M` key (point must be selected) | Per-point |
| Toggle tangent visibility | `T` key or button | Global |
| Undo | `Ctrl+Z` | 50-state cap |
| Redo | `Ctrl+Y` | |

Click threshold for "near curve": `curveWidth * zoom / 2 + 5` pixels.

Hit-test order on left-click, iterating points from last to first (topmost wins):
for each point, in-handle → out-handle → control point; then curve → empty space.

### Design Mode — Insert Point Tangent Calculation

When clicking on a curve at parameter `t` on segment `[i, i+1]`:
1. Compute the derivative vector at `t`, normalize it.
2. `newCp.outTangent = deriv * chordLength * t * 0.5`
3. `newCp.inTangent  = -deriv * chordLength * (1 - t) * 0.5`
4. Shrink flanking tangents: `p0.outTangent *= t`, `p1.inTangent *= (1 - t)`

where `chordLength = |p0.pos → p1.pos|`. This is a heuristic and does **not**
preserve the curve shape exactly. Preferred: replace it with proper **de
Casteljau subdivision** at `t`, which splits the cubic into two cubics that
reproduce the original curve exactly. Do this if implementing fresh.

### Build Mode

Entered via toggle button; locks all curve editing. Disables the width slider and
the tangents toggle.

| Action | Trigger | Detail |
|---|---|---|
| Highlight block | Left-click | Only toggles blocks already in `gridBlocks` |
| Unhighlight block | Left-click highlighted block | Toggle |
| Clear all highlights | `R` key or "Reset Highlight" button | |

Highlighted blocks render as semi-transparent red over the track color.

### Navigation (both modes)

| Action | Mouse | Touch |
|---|---|---|
| Pan | Right-drag | One-finger drag on empty space, or two-finger drag |
| Zoom | Scroll wheel | Pinch |
| Zoom | Zoom slider | Zoom slider |

Scroll/pinch zoom zooms toward the cursor (or pinch midpoint), not the origin.

### Touch / Mobile Input

Build all pointer interaction on the **Pointer Events API** (`pointerdown` /
`pointermove` / `pointerup`, checking `event.pointerType`), not legacy mouse
events — mouse, touch, and pen then share one path. Set `touch-action: none`
(CSS) on the canvas so the browser doesn't hijack drags/pinches.

Touch has no right-click, middle-click, wheel, or modifiers, so:

| Desktop | Touch equivalent |
|---|---|
| Left-drag empty space → pan is right-drag | **One-finger drag on empty space = pan** (adding a point is a *tap*, never a drag — no conflict) |
| Left-drag on point/handle = move | One-finger drag starting on a point/handle = move it |
| Scroll-wheel zoom | Two-finger pinch (track active pointers; zoom toward midpoint) |
| Middle-click point = delete | Long-press the point, **or** select it and tap a delete button |
| Shift+left-drag = move point, fix tangents | A "lock tangents" toggle button |

Principle: **tap = add/insert/select, drag = pan-or-move, two fingers = pan/zoom.**

### Control Panel

| Control | Default | Range / Options |
|---|---|---|
| Width slider | 3 blocks | 1–25 |
| Zoom slider | 10× | 2–40 |
| Toggle tangents button | visible | |
| Design / Build mode toggle | Design | |
| Block count label | always visible | |
| Highlighted count label | Build mode only | |
| Reset Highlight button | Build mode only | |

### File Operations

| Action | Shortcut | Format |
|---|---|---|
| Export track | `Ctrl+S` | `.mtrack` (editable project file) |
| Import track | `Ctrl+O` | `.mtrack` |
| Export schematic | menu / button | `.litematic` (Litematica mod) — final milestone |

`.mtrack` import replaces all current points and saves to undo history.
`.litematic` is a one-way **export** of the built block set; there is no
`.litematic` import.

### Keybinds Reference Dialog

Accessible from a Help menu or `?` button. Lists all keyboard shortcuts.

---

## File Format (.mtrack)

JSON. Tangents stored as relative offsets from `pos`. **Snake_case on disk** —
must stay compatible with files saved by the original Python app.

```json
{
  "control_points": [
    {
      "pos": [0.0, 0.0],
      "in_tangent": [-20.0, 0.0],
      "out_tangent": [20.0, 0.0],
      "mirrored": true
    }
  ]
}
```

**Map field names at the I/O boundary.** In-memory state uses `inTangent` /
`outTangent` (camelCase); the file uses `in_tangent` / `out_tangent`. Convert on
read and write — never `JSON.stringify` the state shape directly, or you emit
camelCase and silently break compatibility with Python-saved files.

---

## Schematic Export (.litematic) — final milestone

Exports the built track as a [Litematica](https://github.com/maruohon/litematica)
schematic for in-game placement. **Export only.** Sequence this **last**: it is a
self-contained serialization project and must not gate the web launch.

> ⚠️ A `.litematic` is **gzip-compressed binary NBT** (Java-edition named-tag
> format, big-endian) with a bit-packed block-index array — not JSON. Verify the
> schema against a current reference; the format has revisions.

### What makes it tractable
The tool's output is a **single horizontal layer** (an ice road being the typical
case), so the 3D region collapses to a plane:
- 2D grid `(x, y)` maps to Minecraft `(x, z)` at one fixed Y.
- `Size.y = 1`; palette is two entries: `minecraft:air` and the road block.
- `EnclosingSize` / region `Size` = bounding box of `gridBlocks`; region
  `Position` = its min corner.

### Axis handedness — watch this
Grid-Y points **down** (screen space). Minecraft-Z increases one way; mapping
screen-Y → MC-Z without a deliberate flip yields a **mirrored** schematic. Decide
the mapping explicitly and verify against an in-game placement.

### Block type
Configurable road block in the export dialog (default `minecraft:blue_ice`,
option `minecraft:packed_ice`). Cells in the bounding box not in `gridBlocks` are
`minecraft:air`.

### Structure (verify against the live format before implementing)
Gzipped NBT, root compound roughly:
- `MinecraftDataVersion` (int) — pin to a target MC version's data version
- `Version` (int) — Litematica schema version
- `Metadata` (compound) — `Name`, `Author`, `Description`, `EnclosingSize{x,y,z}`,
  `TimeCreated`, `TimeModified`, `RegionCount`, `TotalBlocks`, `TotalVolume`
- `Regions` (compound, keyed by region name) — each region:
  - `Position{x,y,z}`, `Size{x,y,z}`
  - `BlockStatePalette` (list of `{ Name, Properties? }`; index 0 = `minecraft:air`)
  - `BlockStates` (long array) — palette indices bit-packed at
    `max(2, ceil(log2(paletteSize)))` bits each. Bit entries can straddle 64-bit
    boundaries — **get this from a reference implementation.**
  - `TileEntities`, `Entities`, `PendingBlockTicks`, `PendingFluidTicks` — empty

### Implementation notes
- Pure serialization of an already-computed block set — keep it in **TypeScript**
  (`core/`), not WASM. No heavy math; the TS ecosystem has the libraries.
- Libraries: an NBT writer (`prismarine-nbt`, or `deepslate` which bundles NBT +
  block-state helpers) plus gzip (`pako`). Confirm the NBT lib emits **big-endian
  Java NBT**, not Bedrock little-endian.
- Trigger a browser download via a `Blob` + object URL, same as `.mtrack` export.

---

## Rendering

Draw order (back to front):
1. Background fill (`#282c34`)
2. Grid lines (skip when `zoom <= 3`)
3. Track blocks (`#a0e8ff`)
4. Highlighted blocks (semi-transparent red, `rgba(255, 0, 0, 0.4)`)
5. Bézier curve overlay (white, semi-transparent — visual reference)
6. Tangent lines and handles (if `showTangents`)
7. Control points (red circle; yellow + larger when selected)
8. Coordinate label (overlaid bottom-right)

> The Python original drew grid lines *over* the blocks. Drawing grid (2) before
> blocks (3) here is intentional — blocks read as solid. Either is fine; this is
> the chosen order.

Tangent handle colors:
- Mirrored: both handles red.
- Not mirrored: in-handle green, out-handle blue.

---

## Build System

| Concern | Tool |
|---|---|
| C++ → WASM | Emscripten (`emcc`) |
| UI framework | React 18 (`@vitejs/plugin-react`) |
| TS bundling | Vite |
| WASM loading | Emscripten ES6 module output |
| Pointer/touch input | Pointer Events API (`touch-action: none`) |
| Tests | Vitest |
| `.litematic` export | NBT writer (`prismarine-nbt` / `deepslate`) + gzip (`pako`) |

Suggested `emcc` flags:
```
emcc wasm/curve.cpp -O2 -s EXPORT_ES6=1 -s MODULARIZE=1 \
  -s EXPORTED_FUNCTIONS='["_compute_blocks","_compute_segment_blocks","_malloc","_free"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -o public/curve.js
```

See `DEPLOYMENT.md` for repo layout, hosting, and the full CI/CD workflow.

---

## Build Order (milestones)

Ship in this order so a working tool exists early and risk is back-loaded:

1. **Skeleton** — Vite + React + TS + Zustand store; `<canvas>` with the RAF
   loop and the cardinal-rule wiring; pan/zoom; grid render.
2. **WASM core + TS reference** — `compute_blocks`, the malloc/HEAP plumbing, and
   the differential test harness (WASM == TS).
3. **Design mode** — add/move/insert/delete points, tangents, mirroring, undo/redo,
   block fill rendering. Use `compute_blocks` (full recompute) first.
4. **Performance pass** — `compute_segment_blocks`, per-segment caching,
   incremental recompute, RAF throttling. Verify 60fps targets.
5. **Build mode** — highlight/unhighlight, reset, counts.
6. **File I/O** — `.mtrack` import/export with field mapping; verify round-trip
   against a file saved by the Python app.
7. **Touch / mobile** — pointer-event gestures, `touch-action: none`.
8. **Polish** — keybinds dialog, coordinate label, control-panel states.
9. **`.litematic` export** — the schematic milestone, last.

---

## Out of Scope

- Auto-update (not applicable to a web app)
- `.litematic` **import** (export only)
- Multi-track / multiple layers
- Undo history persistence across page reload
