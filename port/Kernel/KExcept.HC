//WebTempleOS port: the KExcept asm (see DESIGN.md, try/catch).
//A try label is a label id in the function whose frame is CExcept.rbp.
//TestExcept/TakeExcept throw a wasm resume exception that unwinds to
//that function, which continues at the label.  A catch block can't RET
//back into $LK,"throw",A="MN:throw"$() (its frames are gone by then), so its final RET calls
//$LK,"_CatchEnd",A="MN:_CatchEnd"$(), which does the rest of throw()'s loop.
#assert !((REGG_LOCAL_NON_PTR_VARS|REGG_LOCAL_VARS)&~0xFCC0)

_extern _RESUME U0 PortResume(I64 rbp,I64 label,I64 rsp); //Port: rsp=0 for a catch.

U0 _TestExcept()
{
  CExcept *tmpt=Fs->last_except;
  SetRFlags(tmpt->rflags);
  PortResume(tmpt->rbp,tmpt->hndlr_catch,0);
}

U0 _TakeExcept()
{
  CExcept *tmpt=Fs->last_except;
  PortResume(tmpt->rbp,tmpt->hndlr_untry,tmpt->rsp);
}

U0 _SaveExceptRegs(CExcept *t)
{//No callee-saved regs to save: locals live in the frame.
  no_warn t;
}

_extern _TEST_EXCEPT U0 TestExcept();
_extern _TAKE_EXCEPT U0 TakeExcept();
_extern _SAVE_EXCEPT_REGS U0 SaveExceptRegs(CExcept *t);

U0 PutExcept(Bool catch_it=TRUE)
{//Print exception msg and catch exception.
  "Except:%c:",Fs->except_ch;
  "%P:%P:%P:%P:%P:%P\n",Fs->except_callers[0],Fs->except_callers[1],
	Fs->except_callers[2],Fs->except_callers[3],Fs->except_callers[4],
	Fs->except_callers[5],Fs->except_callers[6],Fs->except_callers[7];
  Fs->catch_except=catch_it;
}

#exe {Option(OPTf_NO_REG_VAR,ON);};

class CTryStk
{
  I64 rbp;
  I64 ret_rip;
  I64 arg1;
  I64 arg2;
};

U0 SysTry(U8 *catch_start,U8 *untry_start)
{
  I64 *rbp=GetRBP;
  CExcept *tmpt=MAlloc(sizeof(CExcept));
  tmpt->hndlr_catch=catch_start;
  tmpt->hndlr_untry=untry_start;
  tmpt->rsp=rbp(U8 *)+sizeof(CTryStk);
  tmpt->rbp=*rbp;
  tmpt->rflags=GetRFlags;
  SaveExceptRegs(tmpt);
  QueIns(tmpt,Fs->last_except);
}

U0 SysUntry()
{
  CExcept *tmpt=Fs->last_except;
  QueRem(tmpt);
  Free(tmpt);
}

U0 throw(I64 ch=0,Bool no_log=FALSE)
{//ch can be up to 8 chars like $LK,"PutChars",A="MN:PutChars"$().
//In the catcher, fetch ch from Fs->except_ch.
  CExcept *tmpt=Fs->last_except;
  Bool was_raw;
  I64 i;
  Fs->except_ch=ch;
  for (i=0;i<TASK_EXCEPT_CALLERS;i++)
    Fs->except_callers[i]=Caller(i+1);
  Fs->except_rbp=GetRBP;
  Fs->catch_except=FALSE;
  if (!no_log)
    AdamLog("Except:%c:%p:%p:%p:%p:%p:%p\n",ch,Fs->except_callers[0],
	  Fs->except_callers[1],Fs->except_callers[2],Fs->except_callers[3],
	  Fs->except_callers[4],Fs->except_callers[5],Fs->except_callers[6],
	  Fs->except_callers[7]);
  while (Fs->next_except!=&Fs->next_except) {
    TestExcept;
    if (Fs->catch_except)
      TakeExcept;
    SetRBP(Fs->except_rbp);
    tmpt=Fs->last_except;
    QueRem(tmpt);
    Free(tmpt);
  }
  was_raw=Raw(ON);
  PutExcept(FALSE);
  Panic("Unhandled Exception");
  Raw(was_raw);
}

#exe {Option(OPTf_NO_REG_VAR,OFF);};

U0 Break()
{//Send <CTRL-ALT-c>.
  if (Bt(&Fs->task_flags,TASKf_BREAK_TO_SHIFT_ESC))
    Msg(MSG_KEY_DOWN,CH_SHIFT_ESC,0x20100000201);
  else {
    Fs->wake_jiffy=0;
    TaskRstAwaitingMsg;
    DrvsRelease();
    BlkDevsRelease();
    FlushMsgs;
    throw('Break');
  }
}

U8 *_BreakAddr()
{//Port: &Break for $LK,"_RestoreTask",A="MN:_RestoreTask"$(), which can't take the addr of a fwd ref.
  return &Break;
}

U0 _CatchEnd()
{//Port: the rest of throw()'s loop, after a catch block ran.
  CExcept *tmpt;
  Bool was_raw;
  if (Fs->catch_except)
    TakeExcept;
  tmpt=Fs->last_except;
  QueRem(tmpt);
  Free(tmpt);
  if (Fs->next_except!=&Fs->next_except)
    TestExcept; //Doesn't return.
  was_raw=Raw(ON);
  PutExcept(FALSE);
  Panic("Unhandled Exception");
  Raw(was_raw);
}

Bool BreakLock(CTask *task=NULL)
{//Disables <CTRL-ALT-c>.
  if (!task) task=Fs;
  return !LBts(&task->task_flags,TASKf_BREAK_LOCKED);
}

Bool BreakUnlock(CTask *task=NULL)
{//Reenables <CTRL-ALT-c> and issues any pending breaks.
  Bool res;
  if (!task) task=Fs;
  res=LBtr(&task->task_flags,TASKf_BREAK_LOCKED);
  if (LBtr(&task->task_flags,TASKf_PENDING_BREAK)) {
    if (task==Fs)
      Break;
    else
      task->rip=&Break;
  }
  return res;
}
