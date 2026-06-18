# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

**IceSpline** is a web app for planning Minecraft ice-road paths using cubic
Bézier splines, rasterizing the curve onto the block grid. (Under the hood it's a
general curve-to-blocks generator; ice roads are the focus.) It is a rewrite of an
existing Python/PySide6 desktop tool. **Two goals drive every decision: (1) better
performance and (2) frictionless web access — no download.**

A C++ core compiled to WebAssembly handles Bézier math and block rasterization.
A React + TypeScript frontend handles state, Canvas-2D rendering, and input.

Read `docs/SPEC.md` for the full functional + technical specification and `docs/DEPLOYMENT.md`
for repo layout and CI/CD.

## Commands

```bash
# Frontend
npm install
npm run dev        # Vite dev server (HMR)
npm run build      # tsc + vite build -> dist/
npm run preview    # serve the production build locally
npm test           # Vitest (unit tests, incl. WASM-vs-TS differential tests)
npm run lint       # ESLint + tsc --noEmit

# WASM core
bash wasm/build.sh # emcc wasm/curve.cpp -> public/curve.js (+ curve.wasm)
```

`bash wasm/build.sh` must be run before `npm run build` AND before `npm test`
(the build needs the emitted `curve.js`/`curve.wasm`; the differential test +
benchmark load `public/curve.js` at runtime). Those artifacts are gitignored, so
a fresh clone must build first or the WASM-loading tests fail. CI runs build.sh
first — see `docs/DEPLOYMENT.md`.

## Architecture (one screen)

```
src/
  core/     framework-free TS: WASM wrapper, curve math, Zustand store, file I/O
  canvas/   <canvas> component + imperative Canvas-2D renderer (RAF loop)
  ui/       pure React: control panel, dialogs, labels
wasm/       curve.cpp (the compute core) + build.sh
public/     curve.js + curve.wasm (emcc output, copied verbatim by Vite)
```

The WASM module is **pure computation** — no DOM, no state, no I/O. `core/` owns
all state and calls WASM whenever block geometry must be recomputed.

## Rules that are easy to get wrong — follow them

1. **React owns the chrome, not the canvas.** React renders DOM (panel, dialogs,
   labels). All drawing is imperative `ctx.*` inside a `requestAnimationFrame`
   loop that reads the store via `getState()`/`subscribe()`. The canvas never
   calls `setState`; React never calls a draw function. They communicate only
   through the Zustand store. See SPEC.md → "Control Panel ↔ Canvas".

2. **No mounted React component may subscribe to `points`.** Reading
   `useStore(s => s.points)` in a rendered component re-renders React on every
   drag frame — the exact failure mode rule 1 prevents. The canvas reads `points`
   only through the non-React `subscribe`/`getState` API.

3. **Recompute incrementally, throttled to a frame.** Dragging one control point
   changes only the ≤2 adjacent segments. Recompute those, not the whole track,
   and coalesce `pointermove` events to one recompute per `requestAnimationFrame`.
   This — not C++ vs JS — is where performance is won. See SPEC.md → "Performance".

4. **`floor`, never truncation, for grid → block.** A block is
   `(Math.floor(grid.x), Math.floor(grid.y))` everywhere — fills, hit-tests,
   the coordinate label. The Python original used `int()` (truncates toward zero)
   in places, which misaligns negative coordinates. Do not reproduce that.

5. **Map field names at the `.mtrack` I/O boundary.** State uses `inTangent` /
   `outTangent`; the on-disk format uses `in_tangent` / `out_tangent` (for
   compatibility with files saved by the Python app). Convert at read/write —
   never `JSON.stringify` the state shape directly.

6. **Keep a TS reference implementation of the block math** alongside the WASM
   call. It is the differential-test oracle (TS and WASM must agree) and a
   fallback. Curve math in `core/` stays framework-free and unit-tested.

## Build order

Ship in milestones (SPEC.md → "Build Order"). The `.litematic` schematic export
is the **last** milestone — its gzipped-NBT bit-packing is a self-contained
project and must not gate the web launch.
