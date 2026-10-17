//WebTempleOS port of KMathA.HC: HolyC versions of the x87 routines.
//_FLOOR,_CEIL,_TRUNC,_ROUND are wasm builtins and _POW,_POW10,_EXP,
//_LN,_LOG2,_LOG10,_ARG are JS builtins (see runtime/builtins.js).

F64 _D3Norm(CD3 *d)
{
  return Sqrt(d->x*d->x+d->y*d->y+d->z*d->z);
}

F64 _D3NormSqr(CD3 *d)
{
  return d->x*d->x+d->y*d->y+d->z*d->z;
}

F64 _D3Dist(CD3 *d1,CD3 *d2)
{
  F64 x=d1->x-d2->x,y=d1->y-d2->y,z=d1->z-d2->z;
  return Sqrt(x*x+y*y+z*z);
}

F64 _D3DistSqr(CD3 *d1,CD3 *d2)
{
  F64 x=d1->x-d2->x,y=d1->y-d2->y,z=d1->z-d2->z;
  return x*x+y*y+z*z;
}

CD3 *_D3Cross(CD3 *prod,CD3 *d1,CD3 *d2)
{
  prod->x=d1->y*d2->z-d1->z*d2->y;
  prod->y=d1->z*d2->x-d1->x*d2->z;
  prod->z=d1->x*d2->y-d1->y*d2->x;
  return prod;
}

F64 _D3Dot(CD3 *d1,CD3 *d2)
{
  return d1->x*d2->x+d1->y*d2->y+d1->z*d2->z;
}

CD3 *_D3Add(CD3 *sum,CD3 *d1,CD3 *d2)
{
  sum->x=d1->x+d2->x;
  sum->y=d1->y+d2->y;
  sum->z=d1->z+d2->z;
  return sum;
}

CD3 *_D3Sub(CD3 *diff,CD3 *d1,CD3 *d2)
{
  diff->x=d1->x-d2->x;
  diff->y=d1->y-d2->y;
  diff->z=d1->z-d2->z;
  return diff;
}

CD3 *_D3Mul(CD3 *prod,F64 s,CD3 *d)
{
  prod->x=s*d->x;
  prod->y=s*d->y;
  prod->z=s*d->z;
  return prod;
}

CD3 *_D3Div(CD3 *quot,CD3 *d,F64 s)
{
  quot->x=d->x/s;
  quot->y=d->y/s;
  quot->z=d->z/s;
  return quot;
}

CD3 *_D3Zero(CD3 *dst)
{
  dst(I64 *)[0]=0;
  dst(I64 *)[1]=0;
  dst(I64 *)[2]=0;
  return dst;
}

CD3 *_D3Copy(CD3 *dst,CD3 *src)
{
  dst(I64 *)[0]=src(I64 *)[0];
  dst(I64 *)[1]=src(I64 *)[1];
  dst(I64 *)[2]=src(I64 *)[2];
  return dst;
}

CD3 *_D3Equ(CD3 *dst,F64 x,F64 y,F64 z)
{
  dst->x=x;
  dst->y=y;
  dst->z=z;
  return dst;
}

CD3 *_D3AddEqu(CD3 *sum,CD3 *d)
{
  sum->x+=d->x;
  sum->y+=d->y;
  sum->z+=d->z;
  return sum;
}

CD3 *_D3SubEqu(CD3 *diff,CD3 *d)
{
  diff->x-=d->x;
  diff->y-=d->y;
  diff->z-=d->z;
  return diff;
}

CD3 *_D3MulEqu(CD3 *prod,F64 s)
{
  prod->x*=s;
  prod->y*=s;
  prod->z*=s;
  return prod;
}

CD3 *_D3DivEqu(CD3 *quot,F64 s)
{
  quot->x/=s;
  quot->y/=s;
  quot->z/=s;
  return quot;
}

CD3 *_D3Unit(CD3 *d)
{
  F64 n=Sqrt(d->x*d->x+d->y*d->y+d->z*d->z);
  if (n(I64)) {
    d->x/=n;
    d->y/=n;
    d->z/=n;
  }
  return d;
}

F64 _Sign(F64 d)
{
  if (d>0)
    return 1.0;
  if (d<0)
    return -1.0;
  return 0;
}

U16 port_fpu_cw=0x037F; //No x87: the control word is just kept.

U0 _Fldcw(U16 w)
{
  port_fpu_cw=w;
}

U16 _Fstcw()
{
  return port_fpu_cw;
}

U16 _Fstsw()
{
  return 0;
}

U0 _Fclex()
{
}

//************************************
//KUtils.HC asm, as HolyC.  These keep the asm's results (e.g. MemSetU16
//returns the end of the dst, like REP_STOSW leaves RDI).

_extern _CALL_ARGV I64 CallArgv(U8 *fp,I64 argc,I64 *argv); //Port: call with args from argv.
_extern _SET_FS_BASE CTask *SetFsBase(CTask *task); //Port: was SET_FS_BASE (RAX).
_extern _SET_GS_BASE CCPU *SetGsBase(CCPU *c); //Port: was SET_GS_BASE (RAX).
_extern _HASH_FIND CHash *HashFind(U8 *needle_str,CHashTable *haystack_table,
	I64 mask,I64 instance=1);

U16 *_MemSetU16(U16 *dst,I64 val,I64 U16cnt)
{
  while (U16cnt-->0)
    *dst++=val;
  return dst;
}

U32 *_MemSetU32(U32 *dst,I64 val,I64 U32cnt)
{
  while (U32cnt-->0)
    *dst++=val;
  return dst;
}

I64 *_MemSetI64(I64 *dst,I64 val,I64 I64cnt)
{
  while (I64cnt-->0)
    *dst++=val;
  return dst;
}

I64 _MemCmp(U8 *ptr1,U8 *ptr2,I64 cnt)
{
  while (cnt-->0) {
    if (*ptr1!=*ptr2) {
      if (*ptr1>*ptr2)
	return 1;
      else
	return -1;
    }
    ptr1++;
    ptr2++;
  }
  return 0;
}

Bool _BEqu(U8 *bit_field,I64 bit,Bool val)
{
  if (val)
    return Bts(bit_field,bit);
  else
    return Btr(bit_field,bit);
}

Bool _LBEqu(U8 *bit_field,I64 bit,Bool val)
{
  if (val)
    return LBts(bit_field,bit);
  else
    return LBtr(bit_field,bit);
}

I64 _ClampI64(I64 num,I64 lo,I64 hi)
{
  if (num<lo) num=lo;
  if (num>hi) num=hi;
  return num;
}

U64 _ClampU64(U64 num,U64 lo,U64 hi)
{
  if (num<lo) num=lo;
  if (num>hi) num=hi;
  return num;
}

I64 _Call(U8 *machine_code)
{
  I64 (*fp)();
  fp=machine_code;
  if (fp)
    return (*fp)();
  return 0;
}

U0 _BFieldOrU32(U8 *bit_field,I64 bit,U32 pattern)
{
  bit_field+=bit>>3;
  *bit_field(U64 *)|=pattern(U64)<<(bit&7);
}

U32 _BFieldExtU32(U8 *bit_field,I64 bit,I64 size)
{
  U64 d=*(bit_field+bit>>3)(U64 *)>>(bit&7);
  return d&(1<<size-1);
}

I64 _XchgI64(I64 *dst,I64 d)
{
  I64 res=*dst;
  *dst=d;
  return res;
}

U32 _XchgU32(U32 *dst,U32 d)
{
  U32 res=*dst;
  *dst=d;
  return res;
}

U16 _XchgU16(U16 *dst,U16 d)
{
  U16 res=*dst;
  *dst=d;
  return res;
}

U8 _XchgU8(U8 *dst,U8 d)
{
  U8 res=*dst;
  *dst=d;
  return res;
}

U0 _RepInU32(U8 *buf,I64 cnt,I64 port)
{
  while (cnt-->0)
    *buf(U32 *)++=InU32(port);
}

U0 _RepInU16(U8 *buf,I64 cnt,I64 port)
{
  while (cnt-->0)
    *buf(U16 *)++=InU16(port);
}

U0 _RepInU8(U8 *buf,I64 cnt,I64 port)
{
  while (cnt-->0)
    *buf++=InU8(port);
}

U0 _RepOutU32(U8 *buf,I64 cnt,I64 port)
{
  while (cnt-->0)
    OutU32(port,*buf(U32 *)++);
}

U0 _RepOutU16(U8 *buf,I64 cnt,I64 port)
{
  while (cnt-->0)
    OutU16(port,*buf(U16 *)++);
}

U0 _RepOutU8(U8 *buf,I64 cnt,I64 port)
{
  while (cnt-->0)
    OutU8(port,*buf++);
}

I64 _CallInd(I64 (*fp_addr)(...),...)
{
  return CallArgv(fp_addr,argc,argv);
}

I64 _CallExtNum(I64 num,...)
{
  return CallArgv(ext[num],argc,argv);
}

I64 _CallExtStr(U8 *name,...)
{
  CHash *tmph=HashFind(name,Fs->hash_table,HTT_FUN|HTT_EXPORT_SYS_SYM);
  U8 *fp;
  if (!tmph)
    return 0;
  if (tmph->type&HTT_FUN)
    fp=tmph(CHashFun *)->exe_addr;
  else
    fp=tmph(CHashExport *)->val;
  return CallArgv(fp,argc,argv);
}

U0 _SetMSR(I64 model_specific_reg,I64 val)
{//Only the segment bases mean something here.
  if (model_specific_reg==IA32_FS_BASE)
    SetFsBase(val);
  else if (model_specific_reg==IA32_GS_BASE)
    SetGsBase(val);
}

U0 _SysHlt()
{
  CLI
  while (TRUE)
    HLT
}
