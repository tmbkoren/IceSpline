# M4 — Performance pass (DEFERRED)

**Status: stashed, not started.** As of 2026-06-18 there is **no felt performance
problem** — dragging, editing, and build mode all feel smooth on the dev machine.
This milestone is therefore deliberately deferred. **Trigger to revive it:** an
actual report of sluggish dragging/editing (especially on a large track or a
weaker device) from a real user. Do not implement speculatively.

This file is the complete plan so it can be picked up cold later. The guiding
principle is CLAUDE.md rule 3: **performance here is won by recomputing *less* and
*less often* — not by C++-vs-JS.** The project's own benchmark backs that up.

## Where the cost is today

Every `pointermove` during a drag calls `movePoint`/`moveTangent` → `setPoints`
(in `src/core/state.ts`) → `computeBlocks(`**whole track**`)` synchronously
(`src/core/blocks.ts`). Two distinct wastes, both named in CLAUDE.md rule 3:

1. **Full-track recompute** when dragging point *i* only changes segments *i−1*
   and *i*.
2. **Per-event recompute** — `pointermove` can fire faster than the frame rate, so
   the rasterizer may run several times per painted frame.

WASM is **not** wired into the live store. The store uses the sync TS
`computeBlocks` on purpose: WASM init is async, the store is sync/framework-free.
The WASM backend (`src/core/wasm.ts`) exists and is differential-tested
(`src/core/blocks.diff.test.ts`) but only the test/bench consume it.

## The plan — measure first, add levers in value/risk order

### Step 0 — Instrument the drag path (do this before optimizing anything)
The user reports no slowdown, so each step must **earn its place with a
before/after number**. Add lightweight instrumentation: ms per recompute,
recomputes-per-painted-frame. Baseline on a small track AND a large one (the notes
cite ~35k-block tracks at n=40/width=25). This is also the honest version for a
learning user — they see what actually moves the needle.

### Step 1 — Coalesce recomputes to one per frame (`src/canvas/input.ts`)
Instead of calling `movePoint`/`moveTangent` on every `pointermove`, stash the
latest grid position + which edit, and flush it once per `requestAnimationFrame`
(dedupe so only one flush is pending; flush the final position + clear the pending
RAF on pointerup). Low risk, one file.

- **Caveat the bench may expose:** browsers already coalesce `pointermove` toward
  frame rate on most hardware (1000 Hz mice are the exception), so this win can be
  marginal. Measure before assuming it's the fix.
- **Why it's visually safe:** the bézier overlay draws from `points` (updates
  instantly); only the blue blocks lag one frame behind. Invisible in practice.

### Step 2 — Incremental segment recompute (`src/core/state.ts` + `src/core/blocks.ts`)
The architectural piece rule 3 calls out. **We cannot subtract one segment's
blocks from the union** — blocks are shared between overlapping segments. So
maintain a per-segment `segmentBlocks: Set<string>[]` (one set per segment) and
derive `gridBlocks` from them. `computeSegmentBlocks` already exists in `blocks.ts`
for exactly this.

- Drag of point *i* → recompute only the dirty segments, not the whole track.
- **Dirty-segment rules:**
  - `movePoint(i)` → segments `{i−1, i}`; clamp at endpoints (point 0 has no left
    segment, last point has no right segment).
  - `moveTangent(i,'in')` → segment `i−1`; `moveTangent(i,'out')` → segment `i`;
    mirrored point → both. ("Both adjacent" `{i−1, i}` is a safe superset if you'd
    rather not special-case in/out.)
  - **Structural edits** (add / insert / delete / clear / load / undo / redo) shift
    segment indices → keep the existing **full** recompute. (The store already does
    a full recompute on all of these — leave it.)

⚠️ **The one fork that decides whether "incremental" actually scales — union maintenance:**
  - **v1 (simple):** rebuild the union `Set` from all segment sets every frame.
    But that's O(total blocks) *regardless* of how few segments changed — on a
    ~35k-block track the **union rebuild**, not the curve math, becomes the
    per-frame cost, and dragging is still track-size-dependent. Ship this first,
    but state plainly that it caps the win.
  - **v2 (escalate only if the bench demands):** a refcount map (block → number of
    segments covering it). On a drag: decrement the 2 old segments' blocks,
    recompute, increment the new; `gridBlocks` changes only where a count crosses
    0↔1 — truly O(changed), track-size-independent.
- **React subscription note:** `ControlPanel` subscribes to `gridBlocks.size`, so a
  recompute that changes the block count must still publish a **new** `Set` (or
  otherwise change `.size`) for the panel readout to update.
- **Don't forget `pruneHighlights`** runs on every recompute (state.ts) — keep it
  wired so stale build-mode highlights still drop.

### Step 3 — WASM, but only where it wins (`src/core/state.ts` + `src/main.tsx`)
Counter-intuitive, and the reason WASM is **not** the headline of this milestone.
The benchmark: small 3-node ≈ tie (TS ahead — call overhead dominates); WASM only
wins once the inner loop is big (medium 2.1×, large 3.0× full-track). **Incremental
recompute makes the drag path tiny (≤2 segments) → the WASM boundary cost would
dominate → TS wins on the drag path.**

So do **not** swap WASM in globally. Scope it to **full-track recomputes** only
(initial load, width change, undo/redo, large `.mtrack` imports); keep TS on the
per-segment drag path. Load the WASM backend at startup in `main.tsx`, fall back to
TS until ready (after init the actual compute call is synchronous). The existing
differential test already guarantees WASM≡TS, so this is safe.

### Step 4 — Re-measure and stop when good enough
Confirm before/after. Don't add v2 refcounts (or anything else) unless a number
justifies it.

## Net ordering
measure → coalescing + incremental (the real wins) → re-measure → WASM for
full-track only if justified. Land as small increments per the usual workflow,
pausing after each.

## Related files
- `src/core/state.ts` — `setPoints` is the single recompute point; the place to add
  segment bookkeeping + the full-vs-incremental fork.
- `src/core/blocks.ts` — `computeBlocks` (full) + `computeSegmentBlocks` (per-segment,
  already exists). Keep both bit-portable to `wasm/curve.cpp` (determinism rules).
- `src/canvas/input.ts` — drag handlers; where RAF coalescing lands.
- `src/core/wasm.ts` — the WASM `BlocksBackend` (malloc-once, grow-on-`-1`).
- `src/core/blocks.diff.test.ts` / `src/core/blocks.bench.ts` — differential test +
  `npm run bench`; extend the bench to cover the drag path (per-segment recompute).
