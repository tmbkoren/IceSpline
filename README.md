# IceSpline

Plan Minecraft ice-road paths with cubic Bézier splines - in the browser, nothing
to download. Draw a smooth curve through control points and IceSpline rasterizes
it onto the block grid, ready to build. (Under the hood it's a general
curve-to-blocks generator; ice roads are the focus.) A C++ → WebAssembly core does
the Bézier math and block rasterization; a React + TypeScript frontend handles
state, Canvas-2D rendering, and input.

This is a web rewrite of an existing Python/PySide6 desktop tool, built for two
reasons: **performance** and **frictionless access**.

## Quick start

```bash
bash wasm/build.sh   # compile the C++ core to public/curve.js + curve.wasm
npm install
npm run dev
```

## Docs

- **[SPEC.md](./docs/SPEC.md)** - full functional + technical specification
- **[DEPLOYMENT.md](./docs/DEPLOYMENT.md)** - repo layout, hosting, CI/CD
- **[CLAUDE.md](./CLAUDE.md)** - guidance for Claude Code in this repo

## Stack

React 19 · TypeScript · Vite · Zustand · Canvas 2D · C++/Emscripten WASM ·
Vitest · GitHub Pages
