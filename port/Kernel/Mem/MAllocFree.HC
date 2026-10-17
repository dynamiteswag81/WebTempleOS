//WebTempleOS port: the MAllocFree asm as HolyC, step by step.
#assert !_CFG_HEAP_DBG //The heap debug code (caller1/caller2, used lst) isn't ported.

U8 *_MAlloc(I64 size,CTask *mem_task=NULL)
{// Throws 'OutMem'
  CHeapCtrl *hc;
  CMemUnused *uum,*tmpu,*prev;
  CMemBlk *tmpm;
  I64 rflags,i;
  U8 *res;
  I64 (*fp_log)(U8 *addr);

  if (!mem_task) mem_task=Fs;
  hc=mem_task;
  if (mem_task->task_signature==TASK_SIGNATURE_VAL)
    hc=mem_task->data_heap;
  if (hc->hc_signature!=HEAP_CTRL_SIGNATURE_VAL) {
    SysBadMAlloc(hc);
    SysHlt;
  }
  rflags=GetRFlags;
  size=(size+offset(CMemUsed.start)+7)&~7; //round-up to I64
  if (size(U64)<offset(CMemUsed.start))
    size=offset(CMemUsed.start);
  CLI
  while (LBts(&hc->locked_flags,HClf_LOCKED))
    PAUSE //don't know if this inst helps

  if (size(U64)<MEM_HEAP_HASH_SIZE) {
    if (uum=hc->heap_hash[size>>3]) {
      hc->heap_hash[size>>3]=uum->next;
      goto malloc_almost_done;
    }
  } else {
//Big allocation
    if (!(tmpm=MemPagTaskAlloc(
	  (size+sizeof(CMemBlk)+MEM_PAG_SIZE-1)>>MEM_PAG_BITS,hc)))
      goto malloc_out_mem;
    size=tmpm->pags<<MEM_PAG_BITS-sizeof(CMemBlk);
    uum=tmpm(U8 *)+sizeof(CMemBlk);
    goto malloc_almost_done;
  }

//Little allocation, chunk-off piece from free lst chunks
  tmpu=&hc->malloc_free_lst(U8 *)-offset(CMemUnused.next);
  while (TRUE) {
    prev=tmpu;
    if (!(tmpu=prev->next)) {
      if (!(tmpm=MemPagTaskAlloc((size+16*MEM_PAG_SIZE-1)>>MEM_PAG_BITS,hc)))
	goto malloc_out_mem;
      i=tmpm->pags<<MEM_PAG_BITS;
//Can it be combined with last chunk? (Never Free these chunks.)
      if (hc->last_mergable==tmpm(U8 *)+i) {
	tmpm->pags+=hc->last_mergable(CMemBlk *)->pags;
	QueRem(hc->last_mergable);
      }
      hc->last_mergable=tmpm;
      tmpu=tmpm(U8 *)+sizeof(CMemBlk);
      i-=sizeof(CMemBlk);
      prev=&hc->malloc_free_lst(U8 *)-offset(CMemUnused.next);
      tmpu->next=prev->next;
      tmpu->size=i;
      prev->next=tmpu;
    } else {
      if (tmpu->size(U64)<size)
	goto malloc_next;
      if (tmpu->size==size) {
	prev->next=tmpu->next;
	uum=tmpu;
	goto malloc_almost_done;
      }
    }
    tmpu->size-=size; //UPDATE FREE ENTRY
    if (tmpu->size(U64)>=sizeof(CMemUnused)) {
      uum=tmpu(U8 *)+tmpu->size; //take from top of block
      goto malloc_almost_done;
    }
    tmpu->size+=size; //doesn't fit, undo
malloc_next:
  }

malloc_out_mem:
  LBtr(&hc->locked_flags,HClf_LOCKED);
  SetRFlags(rflags);
  throw('OutMem',TRUE);

malloc_almost_done:
  hc->used_u8s+=size;
  LBtr(&hc->locked_flags,HClf_LOCKED);
  SetRFlags(rflags);
  uum(CMemUsed *)->size=size;
  uum(CMemUsed *)->hc=hc;
  res=&uum(CMemUsed *)->start;
  if (sys_semas[SEMA_HEAPLOG_ACTIVE].val&1 && (fp_log=ext[EXT_HEAPLOG_MALLOC]))
    (*fp_log)(res);
  if (sys_heap_init_flag&1)
    MemSet(res,sys_heap_init_val,size-offset(CMemUsed.start));
  return res;
}

U0 _Free(U8 *addr)
{//Be aware of heap_hash in $LK,"MemPagTaskAlloc",A="MN:MemPagTaskAlloc"$().
  CMemUsed *uum;
  CHeapCtrl *hc;
  I64 size,rflags;
  U8 *a;
  I64 (*fp_log)(U8 *addr);

  if (sys_semas[SEMA_HEAPLOG_ACTIVE].val&1) {
    if (a=addr) {
      size=(a-offset(CMemUsed.start))(CMemUsed *)->size;
      if (size<0) a+=size; //Aligned alloced chunks have neg size
    }
    if (fp_log=ext[EXT_HEAPLOG_FREE])
      (*fp_log)(a);
  }
  if (!addr) return;
  size=(addr-offset(CMemUsed.start))(CMemUsed *)->size;
  if (size<0) //Aligned alloced chunks have neg size.
    addr+=size; //The neg size is offset to start of $LK,"CMemUsed",A="MN:CMemUsed"$ struct.
  rflags=GetRFlags;
  uum=addr-offset(CMemUsed.start);
  hc=uum->hc;
  if (hc->hc_signature!=HEAP_CTRL_SIGNATURE_VAL) {
    SysBadFree(addr);
    SysHlt;
  }
  size=uum->size;
  hc->used_u8s-=size;
  CLI
  while (LBts(&hc->locked_flags,HClf_LOCKED))
    PAUSE
  if (size(U64)<MEM_HEAP_HASH_SIZE) {
    uum(CMemUnused *)->next=hc->heap_hash[size>>3];
    hc->heap_hash[size>>3]=uum;
  } else
    MemPagTaskFree(uum(U8 *)-sizeof(CMemBlk),hc);
  LBtr(&hc->locked_flags,HClf_LOCKED);
  SetRFlags(rflags);
}

I64 _MSize(U8 *src)
{
  I64 size;
  if (!src) return 0;
  size=(src-offset(CMemUsed.start))(CMemUsed *)->size;
  if (size<0) {//Aligned alloced chunks have neg size
    src+=size;
    size=(src-offset(CMemUsed.start))(CMemUsed *)->size;
  }
  return size-offset(CMemUsed.start);
}

I64 _MSize2(U8 *src)
{
  I64 size;
  if (!src) return 0;
  size=(src-offset(CMemUsed.start))(CMemUsed *)->size;
  if (size<0) //Aligned alloced chunks have neg size
    src+=size;
  return (src-offset(CMemUsed.start))(CMemUsed *)->size;
}

CHeapCtrl *_MHeapCtrl(U8 *src)
{
  I64 size;
  if (!src) return NULL;
  size=(src-offset(CMemUsed.start))(CMemUsed *)->size;
  if (size<0) //Aligned alloced chunks have neg size
    src+=size;
  return (src-offset(CMemUsed.start))(CMemUsed *)->hc;
}

_extern _FREE U0 Free(U8 *addr); //Free $LK,"MAlloc",A="MN:MAlloc"$()ed memory chunk.
_extern _MSIZE I64 MSize(U8 *src); //Size of heap object.
_extern _MSIZE2 I64 MSize2(U8 *src); //Internal size of heap object.
_extern _MHEAP_CTRL CHeapCtrl *MHeapCtrl(U8 *src); //$LK,"CHeapCtrl",A="MN:CHeapCtrl"$ of object.
_extern _MALLOC U8 *MAlloc(I64 size,CTask *mem_task=NULL); //Alloc memory chunk.
//Accepts a $LK,"CTask",A="MN:CTask"$ or $LK,"CHeapCtrl",A="MN:CHeapCtrl"$. NULL allocs off current task's heap.

U8 *AMAlloc(I64 size)
{//Alloc memory in Adam's heap.
  return MAlloc(size,adam_task);
}

U8 *CAlloc(I64 size,CTask *mem_task=NULL)
{//Accepts a $LK,"CTask",A="MN:CTask"$ or $LK,"CHeapCtrl",A="MN:CHeapCtrl"$.  NULL allocs off current task's heap.
  U8 *res=MAlloc(size,mem_task);
  MemSet(res,0,size);
  return res;
}

U8 *ACAlloc(I64 size)
{//Alloc and set to zero memory in Adam's heap.
  return CAlloc(size,adam_task);
}

U8 *MAllocIdent(U8 *src,CTask *mem_task=NULL)
{//Accepts a $LK,"CTask",A="MN:CTask"$ or $LK,"CHeapCtrl",A="MN:CHeapCtrl"$.  NULL allocs off current task's heap.
  U8 *res;
  I64 size;
  if (!src) return NULL;
  size=MSize(src);
  res=MAlloc(size,mem_task);
  MemCpy(res,src,size);
  return res;
}

U8 *AMAllocIdent(U8 *src)
{//Alloc in Adam's heap, ident copy of heap node.
  return MAllocIdent(src,adam_task);
}

U8 *MAllocAligned(I64 size,I64 alignment,
	CTask *mem_task=NULL,I64 misalignment=0)
{//Only powers of two alignment. This is awful.
  I64 mask=alignment-1;
  U8 *ptr=MAlloc(size+mask+sizeof(I64)+misalignment,mem_task),
	*res=(ptr+sizeof(I64)+mask)&~mask+misalignment;
  res(I64 *)[-1]=ptr-res;
#assert offset(CMemUsed.size)==offset(CMemUsed.start)-sizeof(I64)
  return res;
}

U8 *CAllocAligned(I64 size,I64 alignment,
	CTask *mem_task=NULL,I64 misalignment=0)
{//Only powers of two alignment. This is awful.
  I64 mask=alignment-1;
  U8 *ptr=MAlloc(size+mask+sizeof(I64)+misalignment,mem_task),
	*res=(ptr+sizeof(I64)+mask)&~mask+misalignment;
  res(I64 *)[-1]=ptr-res;
#assert offset(CMemUsed.size)==offset(CMemUsed.start)-sizeof(I64)
  MemSet(res,0,size);
  return res;
}

U8 *StrNew(U8 *buf,CTask *mem_task=NULL)
{//Accepts a $LK,"CTask",A="MN:CTask"$ or $LK,"CHeapCtrl",A="MN:CHeapCtrl"$.  NULL allocs off current task's heap.
  U8 *res;
  I64 size;
  if (buf) {
    size=StrLen(buf)+1;
    res=MAlloc(size,mem_task);
    MemCpy(res,buf,size);
  } else {
    res=MAlloc(1,mem_task);
    *res=0;
  }
  return res;
}

U8 *AStrNew(U8 *buf)
{//Alloc copy of string in Adam's heap.
  return StrNew(buf,adam_task);
}
