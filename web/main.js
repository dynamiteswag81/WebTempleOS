// The page: shows the screen the worker draws, sends it keys and mouse.
import { SCANCODES } from '../runtime/ps2.js';

const canvas = document.getElementById('screen');
const status = document.getElementById('status'), log = document.getElementById('log');
const worker = new Worker(new URL('worker.js', import.meta.url), { type: 'module' });
const off = canvas.transferControlToOffscreen();
worker.postMessage({ type: 'start', canvas: off }, [off]);
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'status') status.textContent = m.text;
  else if (m.type === 'snd') speaker(m.hz);
  else if (m.type === 'log') { log.textContent += m.text + '\n'; log.scrollTop = log.scrollHeight; }
};
// PC speaker: a square wave, like the real thing.  Browsers only allow
// audio after a user gesture, so the context starts on the first click/key.
let audio = null, osc = null, gain = null, toneHz = 0;
function audioStart() {
  if (audio) { if (audio.state === 'suspended') audio.resume(); return; }
  audio = new AudioContext();
  osc = audio.createOscillator(); gain = audio.createGain();
  osc.type = 'square'; gain.gain.value = 0;
  osc.connect(gain).connect(audio.destination);
  osc.start();
  speaker(toneHz);
}
function speaker(hz) {
  toneHz = hz;
  if (!audio) return;
  const t = audio.currentTime, on = hz >= 20 && hz <= 20000;
  if (on) osc.frequency.setValueAtTime(hz, t);
  gain.gain.setTargetAtTime(on ? 0.06 : 0, t, 0.003);
}
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, audioStart);

worker.onerror = (e) => { status.textContent = 'Worker error: ' + e.message; };
document.getElementById('logbtn').onclick = () => { log.style.display = log.style.display === 'block' ? 'none' : 'block'; };
document.getElementById('reset').onclick = () => {
  if (confirm('Forget the files saved in this browser and reboot from the original C: drive?')) worker.postMessage({ type: 'reset' });
};

// keyboard: scan codes while the screen has focus
const down = new Set();
function key(e, up) {
  if (document.activeElement !== canvas) return;
  const sc = SCANCODES[e.code];
  if (sc === undefined) return;
  e.preventDefault();
  syncMods(e);
  if (up) down.delete(e.code); else down.add(e.code);
  worker.postMessage({ type: 'key', code: sc, up });
}
// Shift/Ctrl/Alt as the event says they are (a modifier pressed outside
// the page, or synthetic input, sends no key event of its own)
const MODS = [['shiftKey', 'ShiftLeft', 'ShiftRight'], ['ctrlKey', 'ControlLeft', 'ControlRight'], ['altKey', 'AltLeft', 'AltRight']];
function syncMods(e) {
  for (const [flag, l, r] of MODS) {
    if (e.code === l || e.code === r) continue;
    const isDown = down.has(l) || down.has(r);
    if (e[flag] && !isDown) { down.add(l); worker.postMessage({ type: 'key', code: SCANCODES[l], up: false }); }
    else if (!e[flag] && isDown) for (const c of [l, r]) if (down.delete(c)) worker.postMessage({ type: 'key', code: SCANCODES[c], up: true });
  }
}
window.addEventListener('keydown', (e) => key(e, false));
window.addEventListener('keyup', (e) => key(e, true));
canvas.addEventListener('blur', () => { for (const c of down) worker.postMessage({ type: 'key', code: SCANCODES[c], up: true }); down.clear(); });

// mouse: relative motion with pointer lock (TempleOS has a PS/2 mouse)
let buttons = 0;
canvas.addEventListener('click', () => { canvas.focus(); if (document.pointerLockElement !== canvas) canvas.requestPointerLock(); });
const locked = () => document.pointerLockElement === canvas;
document.addEventListener('pointerlockchange', () => {
  status.dataset.lock = locked() ? '1' : '';
  if (!locked() && buttons) { buttons = 0; worker.postMessage({ type: 'mouse', dx: 0, dy: 0, buttons }); }
});
// (Without pointer lock, motion over the screen still moves TempleOS's
// cursor; it just won't line up with the host's.)
canvas.addEventListener('mousemove', (e) => worker.postMessage({ type: 'mouse', dx: e.movementX, dy: e.movementY, buttons }));
const bit = (b) => (b === 0 ? 1 : b === 2 ? 2 : b === 1 ? 4 : 0);
canvas.addEventListener('mousedown', (e) => { if (document.activeElement !== canvas) return; buttons |= bit(e.button); worker.postMessage({ type: 'mouse', dx: 0, dy: 0, buttons }); e.preventDefault(); });
canvas.addEventListener('mouseup', (e) => { if (!(buttons & bit(e.button))) return; buttons &= ~bit(e.button); worker.postMessage({ type: 'mouse', dx: 0, dy: 0, buttons }); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => { e.preventDefault(); worker.postMessage({ type: 'mouse', dx: 0, dy: 0, buttons, dz: Math.sign(e.deltaY) }); }, { passive: false });
canvas.focus();
