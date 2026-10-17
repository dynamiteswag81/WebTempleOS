PROJECT DONE (2026-10-17)

# WebTempleOS: status

TempleOS ported to WebAssembly without x86 emulation. **Start with
HANDOFF.md** (how to run it, where things are, what could be improved).
DESIGN.md holds the architecture.

## Done
- `node server.cjs`: a browser tab boots TempleOS to its normal desktop
  (Adam, the window manager, user terminals; 640x480 16 colors).
- Keyboard (PS/2 scan codes) and mouse (PS/2, pointer lock) work.
- HolyC typed at the command line is JIT-compiled and run by the real
  TempleOS Compiler: Compiler.BIN as wasm, its COCCompile feeding the
  wasm back-end (runtime/jit.js).
- Files on C: survive a reload: the RedSea disk image's written sectors
  are kept in IndexedDB.
- `node test/boot.mjs` reaches the same desktop headless.
- Tests: `node test/run.mjs`, `node test/jit.mjs [-adam]`,
  `node test/browser.mjs` (Playwright Chromium).

## Pieces
- Bootstrap compiler: a literal JS port of TempleOS's front-end; it builds
  Kernel.BIN and Compiler.BIN (TempleOS BINs carrying wasm).
- IC->wasm back-end shared by the bootstrap (AOT) and the run-time JIT.
- Kernel and Adam asm ported to HolyC in `port/`, at the same spots.
- Devices in JS: PIC, PIT, CMOS, ATA disk, 8042 keyboard/mouse, VGA.
- Tasks run on their own JSPI stacks.
