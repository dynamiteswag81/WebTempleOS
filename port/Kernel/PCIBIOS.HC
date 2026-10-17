//WebTempleOS port of the PCIBIOS asm.  There is no BIOS: the search for
//the PCI BIOS service directory (SYS_FIND_PCIBIOS_SERVICE_DIR and
//SYS_FIND_PCI_SERVICES) finds nothing, so these stay 0 and $LK,"FarCall32",A="MN:FarCall32"$()
//never has a 32-bit routine to call.
asm {
USE32

SYS_PCIBIOS_SERVICE_DIR:: DU32	0;
SYS_PCI_SERVICES::	 DU32	0;

USE64
C32_EAX::	DU32	0;
C32_EBX::	DU32	0;
C32_ECX::	DU32	0;
C32_EDX::	DU32	0;
C32_ESI::	DU32	0;
C32_EDI::	DU32	0;
C32_EFLAGS::	DU32	0;

C32_RSP::	DU64	0;
C32_ADD::	DU32	0;
}

Bool _FarCall32(U0 (*fp_addr)())
{//No 32-bit mode to switch to.
  no_warn fp_addr;
  return FALSE;
}

_extern C32_EAX U32 c32_eax;
_extern C32_EBX U32 c32_ebx;
_extern C32_ECX U32 c32_ecx;
_extern C32_EDX U32 c32_edx;
_extern C32_ESI U32 c32_esi;
_extern C32_EDI U32 c32_edi;
_extern C32_EFLAGS U32 c32_eflags;
_extern SYS_PCI_SERVICES U32 sys_pci_services;

_extern _FAR_CALL32 Bool FarCall32(U0 (*fp_addr)());//Not reentrant.For PCIBIOS.

U8 PCIReadU8(I64 bus,I64 dev,I64 fun,I64 rg)
{//Read U8 in PCI configspace at bus,dev,fun,reg.
  I64 res;
  PUSHFD
  CLI
  while (LBts(&sys_semas[SEMA_FAR_CALL32],0))
    Yield;
  c32_eax=0xB108;
  c32_ebx=bus<<8+dev<<3+fun;
  c32_edi=rg;
  if (FarCall32(sys_pci_services))
    res=c32_ecx.u8[0];
  else
    res=0xFF;
  LBtr(&sys_semas[SEMA_FAR_CALL32],0);
  POPFD
  return res;
}

U16 PCIReadU16(I64 bus,I64 dev,I64 fun,I64 rg)
{//Read U16 in PCI configspace at bus,dev,fun,reg.
  I64 res;
  PUSHFD
  CLI
  while (LBts(&sys_semas[SEMA_FAR_CALL32],0))
    Yield;
  c32_eax=0xB109;
  c32_ebx=bus<<8+dev<<3+fun;
  c32_edi=rg;
  if (FarCall32(sys_pci_services))
    res=c32_ecx.u16[0];
  else
    res=0xFFFF;
  LBtr(&sys_semas[SEMA_FAR_CALL32],0);
  POPFD
  return res;
}

U32 PCIReadU32(I64 bus,I64 dev,I64 fun,I64 rg)
{//Read U32 in PCI configspace at bus,dev,fun,reg.
  I64 res;
  PUSHFD
  CLI
  while (LBts(&sys_semas[SEMA_FAR_CALL32],0))
    Yield;
  c32_eax=0xB10A;
  c32_ebx=bus<<8+dev<<3+fun;
  c32_edi=rg;
  if (FarCall32(sys_pci_services))
    res=c32_ecx;
  else
    res=0xFFFFFFFF;
  LBtr(&sys_semas[SEMA_FAR_CALL32],0);
  POPFD
  return res;
}

U0 PCIWriteU8(I64 bus,I64 dev,I64 fun,I64 rg,I64 val)
{//Write U8 in PCI configspace at bus,dev,fun,reg.
  PUSHFD
  CLI
  while (LBts(&sys_semas[SEMA_FAR_CALL32],0))
    Yield;
  c32_eax=0xB10B;
  c32_ebx=bus<<8+dev<<3+fun;
  c32_edi=rg;
  c32_ecx=val;
  FarCall32(sys_pci_services);
  LBtr(&sys_semas[SEMA_FAR_CALL32],0);
  POPFD
}

U0 PCIWriteU16(I64 bus,I64 dev,I64 fun,I64 rg,I64 val)
{//Write U16 in PCI configspace at bus,dev,fun,reg.
  PUSHFD
  CLI
  while (LBts(&sys_semas[SEMA_FAR_CALL32],0))
    Yield;
  c32_eax=0xB10C;
  c32_ebx=bus<<8+dev<<3+fun;
  c32_edi=rg;
  c32_ecx=val;
  FarCall32(sys_pci_services);
  LBtr(&sys_semas[SEMA_FAR_CALL32],0);
  POPFD
}

U0 PCIWriteU32(I64 bus,I64 dev,I64 fun,I64 rg,I64 val)
{//Write U32 in PCI configspace at bus,dev,fun,reg.
  PUSHFD
  CLI
  while (LBts(&sys_semas[SEMA_FAR_CALL32],0))
    Yield;
  c32_eax=0xB10D;
  c32_ebx=bus<<8+dev<<3+fun;
  c32_edi=rg;
  c32_ecx=val;
  FarCall32(sys_pci_services);
  LBtr(&sys_semas[SEMA_FAR_CALL32],0);
  POPFD
}

I64 PCIClassFind(I64 class_code,I64 n)
{/*Find bus,dev,fun of Nth class_code dev.

class_code is low three bytes
n is index starting at zero
Return: -1 not found
else bus,dev,fun.
*/
  I64 res;
  PUSHFD
  CLI
  while (LBts(&sys_semas[SEMA_FAR_CALL32],0))
    Yield;
  c32_eax=0xB103;
  c32_esi=n;
  c32_ecx=class_code;
  if (FarCall32(sys_pci_services) && !c32_eax.u8[1])
    res=c32_ebx.u8[1]<<16+(c32_ebx&0xF8)<<5+c32_ebx&7;
  else
    res=-1;
  LBtr(&sys_semas[SEMA_FAR_CALL32],0);
  POPFD
  return res;
}

