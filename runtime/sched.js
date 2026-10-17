// Task switching with JSPI (see DESIGN.md, Tasks).
//
// Each TempleOS task runs on its own suspendable wasm stack.  The kernel's
// scheduler (_Yield/_RestoreTask in port/Kernel/Sched.HC) is HolyC; when it
// has picked the next task it calls CtxSwitch(task), which lands here:
//  - the current stack is suspended (its sp/rbp are kept with it),
//  - the target's stack is resumed, or started if the task has none yet.
// A task's rip is _RET while its stack holds its context.  Anything else is
// code to run: a new task's start address (run here, on a fresh stack), or
// a Break/task_end_cb set by someone else (called by _TaskContextRestore on
// top of the resumed stack).
import { OP, T, Bytes, ModuleBuilder } from '../compiler/wasm.js';

export class Halt extends Error {}

export class Sched {
  constructor(m) {
    this.m = m;
    this.cur = 0;          // CTask * running now (0: none yet)
    this.stacks = new Map(); // CTask * -> {num, sp, rbp, resolve}
    this.switches = 0;
    this.lastBreath = performance.now();
    this.start = WebAssembly.promising(taskStartFunc(m));
  }
  get off() { return this.m.port; }
  taskNum(t) { return this.m.dv.getBigInt64(t + this.off.taskNum, true); }

  // _CTX_SWITCH: suspend the running stack and run 'task'.
  switchTo(task) {
    const m = this.m;
    if (!this.cur) { this.cur = task; return 0n; } // the boot stack becomes task's
    if (task === this.cur) {
      // (RFLAGS: _TaskContextRestore or _IntDeliver restores them.)
      // A task busy-waiting alone still has to let the JS event loop run
      // (timers, input, the screen) now and then.
      if (!this.breathe()) return 0n;
      return new Promise((res) => setTimeout(() => res(0n), 0));
    }
    this.switches++;
    const self = { num: this.taskNum(this.cur), sp: m.sp.value, rbp: m.rbp.value, resolve: null };
    const p = new Promise((res) => { self.resolve = res; });
    this.stacks.set(this.cur, self);
    // Runs once this stack has suspended (we return p to it first).
    if (this.breathe()) setTimeout(() => this.enter(task), 0);
    else queueMicrotask(() => this.enter(task));
    return p;
  }
  // true about every 10 ms: time to give the event loop a turn
  breathe() {
    const t = performance.now();
    if (t - this.lastBreath < 10) return false;
    this.lastBreath = t;
    return true;
  }

  enter(task) {
    const m = this.m, dv = m.dv, off = this.off;
    this.cur = task;
    const s = this.stacks.get(task);
    if (s) this.stacks.delete(task);
    if (s && s.num === this.taskNum(task)) {
      m.sp.value = s.sp; m.rbp.value = s.rbp;
      s.resolve(0n);
      return;
    }
    // A new task (or one whose CTask memory was reused): start it.  [rsp]
    // is its return addr (&Exit for Spawn), its args are above that.
    m.rflags.value = dv.getBigInt64(task + off.rflags, true); // IRET into the new task
    if (off.irqDepthAddr) dv.setBigInt64(off.irqDepthAddr, 0n, true);
    const rip = Number(dv.getBigInt64(task + off.rip, true));
    dv.setBigInt64(task + off.rip, BigInt(m.RET), true);
    m.sp.value = Number(dv.getBigInt64(task + off.rsp, true));
    m.rbp.value = Number(dv.getBigInt64(task + off.rbp, true));
    const idx = dv.getUint32(rip, true);
    this.start(idx).then(
      () => m.fail(new Error(`task ${task.toString(16)} returned from its stack`)),
      (e) => m.fail(e));
  }
}

// start(table_index): call the function with [sp] as its return marker,
// then, as a RET would, "return" into that marker's code (e.g. Exit).
function taskStartFunc(m) {
  const mb = new ModuleBuilder();
  mb.importTable('env', 'table', 1);
  mb.importMemory('env', 'mem', m.memPages, m.memPages, true);
  const sp = mb.importGlobal('env', 'sp', T.i32, true);
  const fnType = mb.type([], [T.i64]);
  const f = mb.reserveFunc([T.i32], [T.i64], 'task_start');
  const b = new Bytes();
  // l1 = marker (low 32 bits of [sp])
  b.u8(OP.global_get).u32(sp).u8(OP.i32_load).u32(2).u32(0).u8(OP.local_set).u32(1);
  b.u8(OP.local_get).u32(0).u8(OP.call_indirect).u32(fnType).u32(0).u8(OP.drop);
  b.u8(OP.local_get).u32(1).u8(OP.i32_eqz);
  b.u8(OP.if).u8(T.i64).u8(OP.i64_const).s64(0n);
  b.u8(OP.else).u8(OP.local_get).u32(1).u8(OP.i32_load).u32(2).u32(0).u8(OP.call_indirect).u32(fnType).u32(0);
  b.u8(OP.end);
  f.f.locals = [[1, T.i32]];
  f.f.body = b.toU8();
  mb.export('task_start', 0, f.idx);
  const inst = new WebAssembly.Instance(new WebAssembly.Module(mb.encode()),
    { env: { table: m.table, mem: m.memory, sp: m.sp } });
  return inst.exports.task_start;
}
