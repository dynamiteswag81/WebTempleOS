//WebTempleOS port: SYS_INIT_PAGE_TABLES and SYS_INIT_16MEG_SYS_CODE_BP as
//HolyC.  $LK,"KStartWasm",A="MN:KStartWasm"$() calls them where KStart32 did.
//Wasm has no paging; the tables are still built because the kernel reads
//them ($LK,"MemPageTable",A="MN:MemPageTable"$) and they cost little.

_extern MEM_2MEG_NUM U64 mem_2meg_num;
_extern MEM_1GIG_NUM U64 mem_1gig_num;
_extern MEM_512GIG_NUM U64 mem_512gig_num;
_extern MEM_PML2 U64 *mem_pml2;
_extern MEM_PML3 U64 *mem_pml3;
_extern MEM_PML4 U64 *mem_pml4;
_extern MEM_E801 U16 mem_e801[2];

U0 SysInitPageTables()
{
  I64 i,a;
  U64 *pte;
  U8 *top;
  mem_page_size=1<<21; //1Gig pages are commented-out in the original, too.

//Set mapped space limit
  a=mem_physical_space;
  if (Bt(&mem_page_size,30)) //Round-up to 1Gig boundary?
    a=(a+0x3FFFFFFF)&~0x3FFFFFFF;
  mem_mapped_space=a+1<<32; //Need 4Gig extra for uncached alias up at top of space.

  mem_2meg_num=(mem_mapped_space+0x1FFFFF)>>21;
  mem_1gig_num=(mem_2meg_num+0x1FF)>>9;
  mem_512gig_num=(mem_1gig_num+0x1FF)>>9;

//Set $LK,"CSysFixedArea",A="MN:CSysFixedArea"$ to zero
  MemSet(SYS_FIXED_AREA,0,sizeof(CSysFixedArea));
  top=SYS_FIXED_AREA+sizeof(CSysFixedArea);

  mem_pml2=top;
  if (!Bt(&mem_page_size,30))
    top+=((mem_2meg_num+0x1FF)&~0x1FF)*8;
  mem_pml3=top;
  top+=((mem_1gig_num+0x1FF)&~0x1FF)*8;
  mem_pml4=top;
  top+=((mem_512gig_num+0x1FF)&~0x1FF)*8;
  mem_heap_base=top;

//Set page tables to zero
  MemSet(mem_pml2,0,mem_heap_base-mem_pml2(U8 *));

  if (Bt(&mem_page_size,30)) {
//PML3: Use 1Gig Pages
    for (i=0,pte=mem_pml3;i<mem_1gig_num;i++)
      *pte++=0x87+i<<30;
  } else {
//PML2: Use 2Meg Pages
    for (i=0,pte=mem_pml2;i<mem_2meg_num;i++)
      *pte++=0x87+i<<21;
//PML3: Use 2Meg Pages
    for (i=0,pte=mem_pml3;i<mem_1gig_num;i++)
      *pte++=mem_pml2(I64)+7+i<<12;
  }
//PML4
  for (i=0,pte=mem_pml4;i<mem_512gig_num;i++)
    *pte++=mem_pml3(I64)+7+i<<12;
}

U0 SysInit16MegSysCodeBp()
{// Init sys_code_bp to BIOS E801 lowest 16Meg val.
// $LK,"BlkPoolsInit",A="MN:BlkPoolsInit"$() adds the rest.
  CBlkPool *bp=SYS_FIXED_AREA+offset(CSysFixedArea.sys_code_bp);
  CMemBlk *m=mem_heap_base;
  I64 size;
  sys_code_bp=bp;
  sys_data_bp=NULL;
  size=mem_e801[0]<<10+0x100000-mem_heap_base;
  if (sys_mem_init_flag&1)
    MemSet(m,sys_mem_init_val,size);
  size>>=MEM_PAG_BITS;
  m->next=bp->mem_free_lst;
  bp->mem_free_lst=m;
  m->mb_signature=MBS_UNUSED_SIGNATURE_VAL;
  m->pags=size;
  bp->alloced_u8s+=size<<MEM_PAG_BITS;
  LBts(&sys_run_level,RLf_16MEG_SYS_CODE_BP);
}

I64 *MemPageTable(U8 *a)
{//Point to page table entry for addr.
  if (Bt(&mem_page_size,30))
    return *MEM_PML3(U64 *)+a>>30*8;
  else
    return *MEM_PML2(U64 *)+a>>21*8;
}
