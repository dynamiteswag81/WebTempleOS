//WebTempleOS port of KStart16.HC: the data only.
//The 16-bit start-up code (BIOS calls for VGA, E801/E820 mem maps, PCI bus
//count, A20, GDT, switch to 32-bit) is done by the JS boot loader
//(runtime/boot.js), which fills these vars in as the original code does.
asm {
USE16
SYS_KERNEL:: //This must match CKernel.
	DU8	0xE9,0,0; //Was JMP I16 CORE0_16BIT_INIT.

//************************************
//  ASM Global vars required for 16-bit start-up
	ALIGN	4,OC_NOP
SYS_BOOT_SRC::			DU32	BOOT_SRC_NULL;
SYS_BOOT_BLK::			DU32	0;
SYS_BOOT_PATCH_TABLE_BASE::	DU32	0;
SYS_RUN_LEVEL::			DU32	0;
#exe {StreamPrint("SYS_COMPILE_TIME:: DU64 0x%X;",Now);}
#assert SYS_COMPILE_TIME+sizeof(CDate)+sizeof(CBinFile)<DVD_BLK_SIZE

MEM_BOOT_BASE::		DU32	0;	//Offset from start used by reboot
MEM_E801::		DU16	0,0;
MEM_E820::		DU8	MEM_E820_ENTRIES_NUM*sizeof(CMemE820) DUP (0);
MEM_PHYSICAL_SPACE::	DU64	0;
SYS_GDT_PTR::		DU16	sizeof(CGDT)-1;
			DU64	0;
SYS_PCI_BUSES::		DU16	0;

	ALIGN	16,OC_NOP
SYS_GDT:: //See CGDT
GDT_NULL:	DU64	0,0;
GDT_BOOT_DS:	DU64	0x00CF92000000FFFF,0;
GDT_BOOT_CS:	DU64	0x00CF9A000000FFFF,0;
GDT_CS32:	DU64	0x00CF9A000000FFFF,0;
GDT_CS64:	DU64	0x00209A0000000000,0;
GDT_CS64_RING3:	DU64	0x0020FA0000000000,0;
GDT_DS:		DU64	0x00CF92000000FFFF,0;
GDT_DS_RING3:	DU64	0x00CFF2000000FFFF,0;
GDT_TR:		DU8	MP_PROCESSORS_NUM*16 DUP(0);
GDT_TR_RING3:	DU8	MP_PROCESSORS_NUM*16 DUP(0);
#assert $$-SYS_GDT==sizeof(CGDT)

#assert $$-SYS_KERNEL==sizeof(CKernel)-sizeof(CBinFile)
}
