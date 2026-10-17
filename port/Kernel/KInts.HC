//WebTempleOS port: the KInts asm.  An IDT entry holds a function
//descriptor (or a fault stub address in dbg.int_fault_code), and IRQs are
//taken by wasm code at STI/POPFD, PAUSE and HLT ($LK,"_IrqPoll",A="MN:_IrqPoll"$), never from JS,
//so a handler may switch tasks (suspend the wasm stack) like IRQ_TIMER does.
asm {
INT_MP_CRASH_ADDR:: //Forward reference to work around compiler
	DU32	0; //Port: $LK,"KStartWasm",A="MN:KStartWasm"$() fills in &IntMPCrash.
INT_FAULT:: //Only an address here: the fault stubs are never executed.
	DU8	0;
	ALIGN	4,0
INT_FAULT_ERR_CODE_BITMAP::
	DU32	0x00027D00,0,0,0,0,0,0,0;
}

_extern _IRQ_PENDING I64 IrqPending(); //Port: next IRQ vector, or -1.
_extern _HLT_WAIT U0 HltWait(); //Port: wait for an IRQ (HLT).
extern U0 IntCore0TimerHndlr(CTask *);
extern U0 Fault2(I64 fault_num,I64 fault_err_code);
extern U8 *IntEntryGet(I64 irq);

I64 port_irq_rflags; //RFLAGS of the interrupted code (what IRET restores).

U0 _IntFault(I64 num)
{//INT_FAULT: a CPU exception.
  CTask *task=Fs;
  task->fault_num=num;
  task->fault_err_code=0; //No error code is pushed for us.
  task->rip=_RET;
  task->rflags=port_irq_rflags;
  task->rsp=GetRSP;
  task->rbp=GetRBP;
  Fault2(task->fault_num,task->fault_err_code);
  _RestoreTask(Fs); //RESTORE_FS_TASK
}

U0 _IntDeliver(I64 vec)
{//The CPU part of an interrupt: IF off, call the gate, IRET.
  U8 *fp=IntEntryGet(vec);
  I64 rflags=GetRFlags,old_irq_rflags=port_irq_rflags;
  port_irq_rflags=rflags;
  SetRFlags(rflags&~(1<<RFLAGf_INT));
  if (dbg.int_fault_code<=fp<dbg.int_fault_code+256*7)
    _IntFault((fp-dbg.int_fault_code)/7);
  else
    Call(fp);
  port_irq_rflags=old_irq_rflags;
  SetRFlags(rflags);
}

U0 _IntDivZero()
{//Port: #DE from a DIV/MOD (the backend's div helpers call this).
  _IntDeliver(I_DIV_ZERO);
}

U0 _IrqPoll()
{
  I64 vec;
  while ((vec=IrqPending)>=0)
    _IntDeliver(vec);
}

U0 _Sti()
{//STI or POPFD turned IF on.
  _IrqPoll;
}

U0 _Pause()
{
  if (Bt(&port_irq_rflags,0)) {} //(keeps the var used)
  if (GetRFlags&1<<RFLAGf_INT)
    _IrqPoll;
}

U0 _Hlt()
{
  HltWait; //Throws if IF is off: that's a halted CPU.
  _IrqPoll;
}

U0 _IntWake()
{//INT_WAKE: just the LAPIC EOI; there's no LAPIC.
}

U0 _IrqTimer()
{//IRQ_TIMER
  CTask *task=Fs;
  CCPU *c=Gs;
  task->rip=_RET; //TASK_CONTEXT_SAVE
  task->rflags=port_irq_rflags;
  task->rsp=GetRSP;
  task->rbp=GetRBP;
  lock c->total_jiffies++;
  if (Bt(&task->task_flags,TASKf_IDLE))
    lock c->idle_pt_hits++;
  if (c->profiler_timer_irq)
    (*c->profiler_timer_irq)(task); //See $LK,"ProfTimerInt",A="MN:ProfTimerInt"$().
  CLI
  if (!c->num)
    IntCore0TimerHndlr(task); //Only Core 0 calls this.
  if (task==c->idle_task)
    _RestoreTask(c->seth_task); //RESTORE_SETH_TASK_IF_READY
  else
    _RestoreTask(task);
}

U8 *IntEntryGet(I64 irq)
{//Get interrupt vector.
  U8 *res;
  I64 *src;
  src=dev.idt(U8 *)+irq*16;
  res(I64).u16[0]=*src(U16 *);
  src(U8 *)+=6;
  res(I64).u16[1]=*src(U16 *)++;
  res(I64).u32[1]=*src(U32 *);
  return res;
}

U8 *IntEntrySet(I64 irq,U0 (*fp_new_hndlr)(),I64 type=IDTET_IRQ,I64 dpl=0)
{//Set interrupt vector. See $LK,"IDTET_IRQ",A="MN:IDTET_IRQ"$.
//See $LK,"::/Demo/Lectures/InterruptDemo.HC"$.
  //See $LK,"::/Demo/MultiCore/Interrupts.HC"$.
  I64 fp=fp_new_hndlr;
  U8 *res,*dst;
  PUSHFD
  CLI
  res=IntEntryGet(irq);
  dst=dev.idt(U8 *)+irq*16;
  *dst(U16 *)++=fp.u16[0];
  *dst(U16 *)++=offset(CGDT.cs64);
  *dst(U16 *)++=0x8000+type<<8+dpl<<13;
  *dst(U16 *)++=fp.u16[1];
  *dst(U32 *)++=fp.u32[1];
  *dst(U32 *)=0;
  POPFD
  return res;
}

U0 IntsInit()
{//Init 8259
  OutU8(0x20,0x11); //IW1
  OutU8(0xA0,0x11); //IW1
  OutU8(0x21,0x20); //IW2
  OutU8(0xA1,0x28); //IW2
  OutU8(0x21,0x04); //IW3
  OutU8(0xA1,0x02); //IW3
  OutU8(0x21,0x0D); //IW4
  OutU8(0xA1,0x09); //IW4
  OutU8(0x21,0xFA); //Mask all but IRQ0 (timer) and IRQ2 Cascade.
  OutU8(0xA1,0xFF);
}

interrupt U0 IntNop()
{//Make unplanned IRQs stop by all means!
  OutU8(0xA0,0x20);
  OutU8(0x20,0x20);
  *(dev.uncached_alias+LAPIC_EOI)(U32 *)=0;
}

interrupt U0 IntDivZero()
{
  if (Gs->num) {
    mp_cnt=1;
    dbg.mp_crash->cpu_num=Gs->num;
    dbg.mp_crash->task=Fs;
    dbg.mp_crash->rip=*(GetRBP+8)(U8 **); //Get RIP off of stk.
    dbg.mp_crash->msg="Div Zero";
    dbg.mp_crash->msg_num=0;
    MPInt(I_MP_CRASH,0);
    SysHlt;
  }
  throw('DivZero');
}

U8 *IntFaultHndlrsNew()
{
  I64 i;
  U8 *res=MAlloc(256*7,Fs->code_heap),*dst=res;
  for (i=0;i<256;i++) {
    *dst++=0x6A; //PUSH I8 xx
    *dst(I8 *)++=i;
    *dst++=0xE9; //JMP	I32 xxxxxxxx
    *dst(I32 *)=INT_FAULT-dst-4;
    dst+=4;
  }
  return res;
}

U0 IntInit1()
{//Interrupt descriptor table part1.
  I64 i;
  CSysLimitBase tmp_ptr;
  if (!Gs->num) {//Gs cur $LK,"CCPU",A="MN:CCPU"$ struct
    dev.idt=CAlloc(16*256);
    for (i=0;i<256;i++)
      IntEntrySet(i,&IntNop);
  }
  tmp_ptr.limit=256*16-1;
  tmp_ptr.base =dev.idt;
  no_warn tmp_ptr; //Port: no LIDT, $LK,"_IntDeliver",A="MN:_IntDeliver"$() reads dev.idt.
}

U0 IntInit2()
{//Interrupt descriptor table part2: Core 0 Only.
  I64 i;
  PUSHFD
  CLI
  IntEntrySet(I_DIV_ZERO,&IntDivZero);
  for (i=1;i<0x20;i++)
    IntEntrySet(i,&dbg.int_fault_code[7*i]);
/*In theory, we use the PIC mask reg to insure we don't get
anything but keyboard, mouse and timer IRQs.  In practice, I've
gotten IRQ 0x27, perhaps because I didn't initialize the APIC.
I go ahead and ACK PIC in $LK,"IntNop",A="MN:IntNop"$().
I have no idea why I got a IRQ 0x27.
*/
  IntEntrySet(I_NMI,_SYS_HLT);
  IntEntrySet(I_TIMER,IRQ_TIMER);
  IntEntrySet(I_MP_CRASH,*INT_MP_CRASH_ADDR(U32 *));
  IntEntrySet(I_WAKE,INT_WAKE);
  IntEntrySet(I_DBG,&dbg.int_fault_code[7*I_DBG]);
  POPFD
}
