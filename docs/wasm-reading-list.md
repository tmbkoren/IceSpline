# WASM / Emscripten reading list

Background reading for understanding the JS ↔ WebAssembly boundary in IceSpline —
i.e. how `wasm/curve.cpp` (compiled by `wasm/build.sh`) talks to the TypeScript
in `src/`. The core idea: **only numbers cross the boundary**; everything else
(arrays, results) is passed through shared linear memory via pointers.

## Start here — the boundary & shared memory
- [MDN — WebAssembly Concepts](https://developer.mozilla.org/en-US/docs/WebAssembly/Concepts) — the mental model.
- [MDN — Using the WebAssembly JavaScript API](https://developer.mozilla.org/en-US/docs/WebAssembly/Guides/Using_the_JavaScript_API) — how JS loads and calls a module.
- [MDN — `WebAssembly.Memory`](https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface/Memory) — the linear-memory `ArrayBuffer` that `HEAPF64`/`HEAP32` are views onto.

## Emscripten specifics (our `build.sh` flags + the malloc/HEAP dance)
- [Interacting with code](https://emscripten.org/docs/porting/connecting_cpp_and_javascript/Interacting-with-code.html) — `EXPORTED_FUNCTIONS`, calling C from JS, and the "Access memory from JavaScript" section showing the `_malloc` → `HEAPF64.set` → call → read → `_free` sequence.
- [Settings reference](https://emscripten.org/docs/tools_reference/settings_reference.html) — `MODULARIZE`, `EXPORT_ES6`, `ALLOW_MEMORY_GROWTH`, `EXPORTED_RUNTIME_METHODS`.

## Why the C signatures look the way they do
- [`extern "C"` / name mangling](https://en.cppreference.com/w/cpp/language/language_linkage) — why the exported symbols stay un-mangled.
- [Array-to-pointer decay](https://en.cppreference.com/w/cpp/language/array) — why we pass `pointer + count` instead of an array.

## The build script
- [Bash "strict mode"](http://redsymbol.net/articles/unofficial-bash-strict-mode/) — what `set -euo pipefail` does.

---

**If you only read three:** MDN Concepts, the Emscripten "Interacting with code"
memory-access part, and the bash strict-mode article — together they cover ~80%
of what we built in step 4.
