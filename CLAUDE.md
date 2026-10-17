# WebTempleOS

TempleOS ported to WebAssembly without x86 emulation.
Repo: https://github.com/dynamiteswag81/WebTempleOS (work happens on branch `asm-port`).

Read **HANDOFF.md** first (state, next steps, how to run things), then
**DESIGN.md** (architecture). Keep HANDOFF.md current: it is how one session
hands over to the next.

## Setup
- `sh tools/fetch-vendor.sh` puts the TempleOS source in `vendor/TempleOS`
  (gitignored, pinned commit). Nothing compiles without it.
- Node 24+ (JSPI and wasm exception handling are used). No npm dependencies.

## Commands
```bash
npm run build                  # build/Kernel.BIN, Compiler.BIN, *.MAP, layout.json, C.img
node server.cjs                # http://localhost:8090/ (browser with JSPI)
node test/run.mjs              # backend unit tests (test/hc/*.HC)
node test/jit.mjs [-adam]      # the same tests compiled at run time by the real Compiler
node test/boot.mjs -secs=12    # boot in Node, save build/screen.png
node test/browser.mjs          # boot in Playwright's Chromium, save build/browser.png
node test/cmpkernel.mjs -strict
```
On Windows Git Bash, prefix these with `MSYS_NO_PATHCONV=1` (it rewrites
`/Kernel/...` arguments into Windows paths). On Linux no prefix is needed.

## Rules of the road
- Faithfulness: TempleOS's own HolyC does the work. Port files in `port/`
  keep the original file and replace only what can't run on wasm, at the same
  spot, with a `//WebTempleOS port` comment.
- A lone `$` in a `.HC` comment starts a DolDoc command and silently eats the
  rest of the file. Write `$$`.
- Commit often with clear messages and push to `asm-port`, so a session that
  stops early loses nothing.
