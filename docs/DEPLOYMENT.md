# Deployment & Repository Setup

How to structure the repo and ship it to free static hosting via CI/CD. This
serves goal #2 — frictionless web access with nothing to install.

---

## Repository Layout — Single Repo

The app is a **static site** — the WASM module is just a static asset the browser
fetches. There is no server. Everything lives in one repo: `wasm/` for the C++
core, `src/` for the React + TypeScript frontend (no monorepo tooling needed):

```
icespline/
├── wasm/
│   ├── curve.cpp
│   └── build.sh          # the one emcc command
├── src/
│   ├── core/             # framework-free TS
│   │   ├── wasm.ts       # WASM loader + malloc/HEAP plumbing
│   │   ├── blocks.ts     # TS reference impl of the block math (test oracle)
│   │   ├── curve.ts      # Bézier helpers (eval, derivative, de Casteljau)
│   │   ├── state.ts      # Zustand store
│   │   ├── geometry.ts   # per-segment caches, incremental recompute
│   │   └── mtrack.ts     # .mtrack import/export (field-name mapping lives here)
│   ├── canvas/
│   │   ├── CanvasView.tsx
│   │   └── renderer.ts   # imperative Canvas-2D draw, reads store via getState()
│   ├── ui/
│   │   ├── ControlPanel.tsx
│   │   └── KeybindsDialog.tsx
│   ├── App.tsx
│   └── main.tsx
├── public/
│   └── curve.js          # emcc output (+ curve.wasm) — see note below
├── index.html
├── package.json
├── vite.config.ts
└── .github/workflows/deploy.yml
```

> **Why React (not vanilla, not Vue/Svelte):** developer velocity — it's the
> author's primary tool. The constraint holds regardless of framework: **React
> owns the DOM chrome (`ui/`), never the canvas draw loop.** Drawing is imperative
> `ctx.*` inside a `requestAnimationFrame` loop; `core/` stays plain TS so the
> WASM boundary and curve math stay testable and portable. See SPEC.md.

### Decision: commit the WASM artifacts, or build them in CI?

| | Commit the WASM artifacts | Build WASM in CI |
|---|---|---|
| CI complexity | Trivial — just `npm build` | Install Emscripten (~adds 1–2 min) |
| Repo cleanliness | Binary blobs in git history | Only source committed |
| Risk | Source and binary can drift | None |

**Recommendation: build WASM in CI.** Committed binaries drifting from source is a
papercut that bites later, and Emscripten setup is a single well-maintained Action
(`mymindstorm/setup-emscripten`). Rebuild cost is small.

> Local dev: run `bash wasm/build.sh` once (and after any `curve.cpp` change), then
> `npm run dev`. `public/curve.js` + `curve.wasm` should be gitignored if you build
> in CI.

---

## Hosting — GitHub Pages (recommended)

Pure static output, so any static host works.

| Vendor | Free tier | WASM/static fit | Notes |
|---|---|---|---|
| **GitHub Pages** | Unlimited public, generous | Perfect | Zero extra accounts; deploys from the same repo via Actions. Best default. |
| **Cloudflare Pages** | Very generous, fast CDN | Perfect | Better perf + PR previews, but another account + dashboard config. |
| **Vercel** | Generous, SSR/serverless-geared | Works, overkill | None of its server features are used here. |
| Netlify | Similar to Vercel | Works | No real advantage here. |

**Recommendation: GitHub Pages.** Keeps source, CI, and hosting in one repo — no
third-party account, official first-party deploy Action. Reach for **Cloudflare
Pages** only if you later want a faster CDN, edge functions, or per-PR previews.

### WASM MIME-type caveat
WASM must be served as `application/wasm`. The official Pages deploy action does
this correctly, so it's a non-issue there. Don't host the `.wasm` somewhere that
serves it as `application/octet-stream`, or Emscripten's streaming compile falls
back to a slower path.

---

## CI/CD Pipeline

One workflow, on push to `master`: compile C++ → build frontend → deploy.

```yaml
name: Deploy
on:
  push:
    branches: [master]
permissions:
  contents: read
  pages: write
  id-token: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: mymindstorm/setup-emscripten@v1   # provides emcc
      - run: bash wasm/build.sh                  # emcc curve.cpp -> public/curve.js
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm test                            # WASM-vs-TS differential tests + units
      - run: npm run build                       # vite build -> dist/
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: { name: github-pages }
    steps:
      - uses: actions/deploy-pages@v4
```

> Note: `npm test` runs after the WASM build so the differential tests can load
> the freshly compiled module.

### Vite gotchas you'll hit
- Set `base: '/icespline/'` in `vite.config.ts` (match the repo name) — Pages
  serves from a subpath unless you use a custom domain.
- Make sure `curve.wasm` ends up in `dist/`. Putting `curve.js`/`curve.wasm` in
  `public/` makes Vite copy them verbatim, which is what you want.

### Deploy on every commit vs. on release
No server, no DB — deploying every push to `master` is the simplest, safest choice;
nothing to migrate. To gate behind tags instead:

```yaml
on:
  push:
    tags: ['v*']
```

For a hobby static app, push-to-`master` is the better default.
