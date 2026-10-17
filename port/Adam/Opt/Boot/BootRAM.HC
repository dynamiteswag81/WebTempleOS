#help_index "Call"
//WebTempleOS port: _HI_CALL and _HI_MEMCPY in HolyC.
I64 HiCall(U8 *machine_code)
{
  if (machine_code)
    return Call(machine_code);
  return 0;
}
U8 *HiMemCpy(U8 *dst,U8 *src,I64 cnt)
{
  MemCpy(dst,src,cnt);
  return dst+cnt;
}

#help_index "Boot"
public U0 BootRAM(U8 *filename=NULL)
{//Softboot Kernel.BIN file. No hardware reset.
  I64 size;
  CKernel *hi_image,*lo_image=mem_boot_base-sizeof(CBinFile),
	reg *sys_ram_reboot;
  if (!filename)
    filename="::/" KERNEL_BIN_C;
  do if (!(hi_image=FileRead(filename,&size))) return;
  while (hi_image<0x100000); //If alloc from low 640K, just get another copy.

  do sys_ram_reboot=MAlloc(SYS_RAM_REBOOT_END-SYS_RAM_REBOOT,Fs->code_heap);
  while (sys_ram_reboot<0x100000);

  hi_image->boot_src=BOOT_SRC_RAM;
  hi_image->boot_blk=0;
  hi_image->boot_patch_table_base=lo_image(U8 *)+hi_image->h.patch_table_offset;
  hi_image->sys_run_level =lo_image->sys_run_level&(RLF_VGA|RLF_16BIT);
  MemCpy(&hi_image->start,&lo_image->start,
	sizeof(CKernel)-offset(CKernel.start));

  CLI
  if (mp_cnt>1)
    MPHalt;

//WebTempleOS port: SYS_RAM_REBOOT (copy the kernel low and jump to
  //it) has no wasm equivalent: the machine reboots instead.
  Reboot;
}
