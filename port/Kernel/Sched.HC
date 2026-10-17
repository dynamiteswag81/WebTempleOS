/*On each core, tasks are linked in a
circular doubly-linked list queue with
the Seth task as the head.  On Core0,
the queue order represents the front-to-back
window stack order with the window mgr
as the wallpaper.

The scheduler is round-robin.  It checks
if a task is ready and runs it or skips it.
Swapping tasks just involves storing and
restoring regs (no disk I/O for virtual
memory and no addr map changes).  It is
always fully identity-mapped on all cores.
Tasks can be switched in half a microsecond.

The scheduler checks if a task is
waiting for a certain time or waiting
on a message and skips if not ready.
A task runs until it voluntarily yields ctrl
with a call to $LK,"Yield",A="MN:Yield"$().  Tasks waiting on I/O
often loop, checking for a status and
$LK,"Yield",A="MN:Yield"$ing.  This does not really degrade
performance, but pegs the CPU Load.

The scheduler checks for a few keys:

<CTRL-ALT-x> kill a task.
<CTRL-ALT-DEL> reboots.
<CTRL-ALT-n> Next task.
<CTRL-ALT-c> breaks execution of a program.

Each core has its own circular task queue.
For AP processors, they have a "Seth" task
which stays in a loop waiting for jobs or
requests to spawn tasks.  See $LK,"CoreAPSethTask",A="MN:CoreAPSethTask"$().
$HL,1$*/

U0 TaskFocusNext()
{
  CTask *task,*_task=sys_focus_task;
  sys_focus_task=NULL;
  if (!_task) _task=adam_task;
  task=_task->next_task;
  do {
    if (!Bt(&task->win_inhibit,WIf_SELF_FOCUS)) {
      sys_focus_task=task;
      CallExtNum(EXT_WIN_TO_TOP,task,TRUE);
      return;
    }
    task=task->next_task;
  } while (task!=_task);
}

//WebTempleOS port: the Sched asm as HolyC.
//There are no registers to save: each task runs on its own suspendable
//wasm stack and $LK,"CtxSwitch",A="MN:CtxSwitch"$() (runtime/sched.js) suspends the
//current one and resumes (or starts) the task's.  TASK_CONTEXT_SAVE is
//what $LK,"_Yield",A="MN:_Yield"$() stores in the CTask.  Breakpoints in machine code
//do not exist here, so bpt_lst is not patched in and out.

_extern _CTX_SWITCH U0 CtxSwitch(CTask *task); //Port: run task's context.
_extern _RET U0 PortRet(); //Port: rip of a task saved by Yield.
extern U0 _RestoreTask(CTask *task);
extern I64 TaskEnd();
extern U8 *_BreakAddr(); //&Break (a fwd ref; was MOV RAX,&Break)
extern U0 Reboot();

U0 _TaskContextRestore()
{//Fs is the task to run.  Returns when this stack's task runs again.
  CTask *task=Fs;
  U8 *rip;
  Gs->swap_cnter++;
  if (Bt(&task->rflags,RFLAGf_INT))
    LBts(&Gs->cpu_flags,CPUf_RAN_A_TASK);
  task->swap_cnter++;
  CtxSwitch(task);
  task=Fs;
  if (task->rip!=_RET) {//Someone set a new rip ($LK,"Break",A="MN:Break"$, task_end_cb).
    rip=task->rip;
    task->rip=_RET;
    Call(rip);
  }
}

U0 _IdleLoop()
{//The idle task.  Was the HLT at the end of RESTORE_RSI_TASK.
  while (TRUE) {
    STI
    HLT
    CLI
    _RestoreTask(Gs->seth_task); //RESTORE_SETH_TASK_IF_READY
  }
}

U0 _RestoreTask(CTask *task)
{//RESTORE_RSI_TASK: run task or the next ready one after it.
  CTask *idle;
restore_rsi_task:
  if (sys_ctrl_alt_flags&(1<<CTRL_ALT_DEL|1<<CTRL_ALT_TAB|1<<CTRL_ALT_X|1<<CTRL_ALT_C))
    goto handle_sysf_key_event;
restore_rsi_task2:
  while (TRUE) {
    if (Bt(&task->task_flags,TASKf_KILL_TASK))
      goto end_rsi_task;
    if (!(task->task_flags&(1<<TASKf_AWAITING_MSG|1<<TASKf_SUSPENDED)) &&
	  task->wake_jiffy<=cnts.jiffies) {
      SetFsBase(task);
      _TaskContextRestore;
      return;
    }
    task=task->next_task;
    if (Gs->seth_task==task && !LBtr(&Gs->cpu_flags,CPUf_RAN_A_TASK)) {
      idle=Gs->idle_task;
      if (!idle->rip)
	idle->rip=&_IdleLoop;
      SetFsBase(idle); //Restore idle task so we can unmask IRQs.
      _TaskContextRestore;
      return;
    }
  }

handle_sysf_key_event:
  SetFsBase(task);
  if (Gs->num)
    goto restore_rsi_task2;
  if (LBtr(&sys_ctrl_alt_flags,CTRL_ALT_DEL))
    Reboot;
  if (Gs->idle_task==task) {
    task=Gs->seth_task;
    goto restore_rsi_task;
  }
  if (LBtr(&sys_ctrl_alt_flags,CTRL_ALT_TAB)) {
    TaskFocusNext;
    task=Fs; //RESTORE_FS_TASK
    goto restore_rsi_task;
  }
  if (LBtr(&sys_ctrl_alt_flags,CTRL_ALT_X))
    goto end_focus_user;
  if (!LBtr(&sys_ctrl_alt_flags,CTRL_ALT_C))
    goto restore_rsi_task;
//BREAK_FOCUS_USER:
  if (!(task=sys_focus_task)) {
    task=Gs->seth_task;
    goto restore_rsi_task;
  }
  if (Bt(&task->win_inhibit,WIf_SELF_FOCUS))
    goto restore_rsi_task;
  if (LBtr(&task->task_flags,TASKf_BREAK_LOCKED)) {
    LBts(&task->task_flags,TASKf_PENDING_BREAK);
    goto restore_rsi_task;
  }
  task->rip=_BreakAddr;
  if (Bt(&task->task_flags,TASKf_BREAK_TO_SHIFT_ESC))
    goto restore_rsi_task;
//Do these now, in case interrupt happens.
  task->wake_jiffy=0;
  TaskRstAwaitingMsg(task);
  goto restore_rsi_task;

end_focus_user:
  task=sys_focus_task;
  TaskFocusNext;
  if (!task) {
    task=Gs->seth_task;
    goto restore_rsi_task;
  }
  SetFsBase(task);
  if (Bt(&task->win_inhibit,WIf_SELF_FOCUS))
    goto restore_rsi_task;
  LBts(&task->task_flags,TASKf_KILL_TASK);
end_rsi_task:
  SetFsBase(task);
  task=TaskEnd;
  SetFsBase(task);
  goto restore_rsi_task;
}

U0 _TaskEndNow()
{
  CTask *task=TaskEnd;
  SetFsBase(task);
  _RestoreTask(task);
}

U0 _Yield()
{
  I64 rflags=GetRFlags;
  CTask *task;
  if (Bt(&sys_semas[SEMA_SINGLE_USER],0))
    return; //If single user, don't change task.
  CLI
  task=Fs;
  task->rflags=rflags;
  task->rsp=GetRSP;
  task->rbp=GetRBP;
  task->rip=_RET;
  _RestoreTask(task->next_task);
}

asm {
SYS_IDLE_PT:: //Was the RIP after the idle HLT.  Only a unique addr here.
	DU8	0;
}

_extern _TASK_CONTEXT_RESTORE U0 TaskContextRestore(); //Restore a task context.
_extern _YIELD U0 Yield(); //Yield cpu to next task.
_extern _TASK_END_NOW U0 TaskEndNow(); //Terminate current task.

U0 TaskQueIns(CTask *task,CTask *pred=NULL)
{//Insert a task in the scheduler running task queue.
//You have no business with this, probably.
  CTask *last;
  PUSHFD
  CLI
  if (!pred) pred=Fs;
  last=pred->last_task;
  last->next_task=pred->last_task=task;
  task->last_task=last;
  task->next_task=pred;
  POPFD
}

U0 TaskQueRem(CTask *task)
{//Remove a task from the scheduler running task queue.
//Use $LK,"Suspend",A="MN:Suspend"$().
  CTask *next,*last;
  PUSHFD
  CLI
  next=task->next_task;
  last=task->last_task;
  last->next_task=next;
  next->last_task=last;
  POPFD
}

U0 TaskQueInsChild(CTask *task)
{
  CTask *last,*pred;
  PUSHFD
  CLI
  pred=task->parent_task->last_child_task;
  last=pred->last_sibling_task;
  last->next_sibling_task=pred->last_sibling_task=task;
  task->last_sibling_task=last;
  task->next_sibling_task=pred;
  POPFD
}
