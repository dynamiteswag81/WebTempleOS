//WebTempleOS port: non-interactive kernel configuration.
//This is run in a $LK,"#exe",A="FF:::/Kernel/Kernel.PRJ,KCfg"${}.
//The original asks the BootHDIns questions; the web build answers them
//the same way every time: one IDE hard drive mounted as C:, no CD/DVD
//probe, single core, 640x480 VGA, default disk cache.

U8 *kernel_cfg_options="MemInit\0HeapInit\0VarInit\0StaffMode\0"
"HomeDir\0NoMP\0TextMode\0DontProbe\0MountIDEAuto\0DbgDistro\0Help\0";

#define CFG_MEM_INIT		0
#define CFG_HEAP_INIT		1
#define CFG_VAR_INIT		2
#define CFG_STAFF_MODE		3
#define CFG_HOME_DIR		4
#define CFG_NO_MP		5
#define CFG_TEXT_MODE		6
#define CFG_DONT_PROBE		7
#define CFG_MOUNT_IDE_AUTO	8
#define CFG_DBG_DISTRO	9
#define CFG_OPTIONS_NUM		10

#define CFG_HELP		10

class CKCfg
{
  U8 *dsk_cache_size_exp;
  CDoc *add_dev;
  U8 *dbg_distro_file,*dbg_distro_start;
  U8 *home_dir;
  Bool opts[CFG_OPTIONS_NUM];
  U8 mem_init_val,heap_init_val,var_init_val,
	boot_drv_let,mount_ide_auto_hd_let,mount_ide_auto_cd_let;
};

CKCfg *KCfgNew()
{
  CKCfg *c=CAlloc(sizeof(CKCfg));
  c->add_dev=NULL;
  c->boot_drv_let='C';
  c->home_dir="::/Home";
  c->dsk_cache_size_exp="Scale2Mem(0x80000,0x8000000)";
  c->opts[CFG_NO_MP]=TRUE;
  c->opts[CFG_DONT_PROBE]=TRUE;
  c->opts[CFG_MOUNT_IDE_AUTO]=TRUE;
  c->mount_ide_auto_hd_let='C';
  c->mount_ide_auto_cd_let='T';
  return c;
}

U0 KCfgDel(CKCfg *)
{
}
