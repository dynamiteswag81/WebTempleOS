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
  else if (m.type === 'log') { log.textContent += m.text + '\n'; log.scrollTop = log.scrollHeight; }
};
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
  if (up) down.delete(e.code); else down.add(e.code);
  worker.postMessage({ type: 'key', code: sc, up });
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
canvas.addEventListener('mousemove', (e) => { if (locked()) worker.postMessage({ type: 'mouse', dx: e.movementX, dy: e.movementY, buttons }); });
const bit = (b) => (b === 0 ? 1 : b === 2 ? 2 : b === 1 ? 4 : 0);
canvas.addEventListener('mousedown', (e) => { if (!locked()) return; buttons |= bit(e.button); worker.postMessage({ type: 'mouse', dx: 0, dy: 0, buttons }); e.preventDefault(); });
canvas.addEventListener('mouseup', (e) => { if (!locked()) return; buttons &= ~bit(e.button); worker.postMessage({ type: 'mouse', dx: 0, dy: 0, buttons }); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => { if (!locked()) return; e.preventDefault(); worker.postMessage({ type: 'mouse', dx: 0, dy: 0, buttons, dz: Math.sign(e.deltaY) }); }, { passive: false });
canvas.focus();
