# WebTempleOS

TempleOS running in a browser tab, ported to WebAssembly. There is no x86
emulator. TempleOS's own HolyC is compiled to wasm and runs natively in the
browser.

> **This whole project was vibe coded.** Every line was written by AI
> (Claude Code, Anthropic's Claude Opus), driven by prompts from a human
> who mostly said "keep going". Expect rough edges.

## What works
- Boots to the normal TempleOS desktop: Adam, the window manager and a user
  terminal on the 640x480 16-color screen.
- Keyboard and mouse.
- PC speaker sound (`Beep;`, `Snd(...)`, the hymns), as a square wave.
- HolyC typed at the command line is compiled at run time by the real
  TempleOS compiler and runs.
- Files you save on `C:` are kept in your browser (IndexedDB) and survive a
  reload.

## Run it
You need [Node.js](https://nodejs.org) 24 or newer, git, and a Chromium-based
browser (Chrome or Edge: it uses WebAssembly JSPI).

```bash
git clone https://github.com/dynamiteswag81/WebTempleOS
cd WebTempleOS
sh tools/fetch-vendor.sh      # the TempleOS source (public domain)
npm run build                 # kernel, compiler and the C: disk image
node server.cjs               # then open http://localhost:8090/
```

The first boot takes a while: TempleOS compiles its whole Adam layer
(window manager, editor, shell...) at startup, just like on real hardware.
Click the screen to capture the mouse; Esc releases it. Click the page once
to enable sound (browsers block audio until you do).

## How it works
- `compiler/`: a literal JavaScript port of TempleOS's compiler front-end,
  used to bootstrap the kernel and the compiler themselves.
- An IC-to-wasm back-end replaces TempleOS's x86 code generator. It serves
  both the bootstrap and the real TempleOS compiler at run time.
- `port/`: TempleOS's assembly routines rewritten in HolyC, at the same
  spots in the original files.
- `runtime/`: the "PC": interrupt controller, timer, clock, IDE disk,
  keyboard/mouse, VGA, speaker. Each TempleOS task runs on its own
  suspendable wasm stack (JSPI).

See [DESIGN.md](DESIGN.md) for the architecture and
[HANDOFF.md](HANDOFF.md) for details and what could be improved.

## License
The port's own code is under the [MIT License](LICENSE). TempleOS itself,
fetched by `tools/fetch-vendor.sh` and partly carried in `port/`, is public
domain.

## Credits
TempleOS is by Terry A. Davis, released into the public domain. This port
is not affiliated with him.
