//HolyC language feature tests (each top-level stmt runs in order).
#include "/Kernel/KernelA.HH"
#include "/Compiler/CompilerA.HH"
_extern __TPI U0 TPI(I64 i);
_extern __TPF U0 TPF(F64 d);
_extern __TPS U0 TPS(U8 *s);

_intern IC_BT Bool Bt(U8 *bit_field,I64 bit);
_intern IC_BTS Bool Bts(U8 *bit_field,I64 bit);
_intern IC_BTR Bool Btr(U8 *bit_field,I64 bit);
_intern IC_LBTS Bool LBts(U8 *bit_field,I64 bit);
_intern IC_STRLEN I64 StrLen(U8 *st);
_intern IC_TOUPPER I64 ToUpper(U8 ch);
_intern IC_MAX_I64 I64 MaxI64(I64 n1,I64 n2);
_intern IC_MIN_U64 U64 MinU64(U64 n1,U64 n2);
_intern IC_MOD_U64 U64 ModU64(U64 *q,U64 d);
_intern IC_SIGN_I64 I64 SignI64(I64 i);
_intern IC_ABS_I64 I64 AbsI64(I64 i);
_intern IC_SQR F64 Sqr(F64 d);
_intern IC_SQRT F64 Sqrt(F64 d);
_intern IC_BSF I64 Bsf(I64 bit_field_val);
_intern IC_BSR I64 Bsr(I64 bit_field_val);
_intern IC_TO_I64 I64 ToI64(F64 d);
_intern IC_TO_F64 F64 ToF64(I64 i);
_intern IC_SWAP_I64 U0 SwapI64(I64 *n1,I64 *n2);
_intern IC_QUE_INIT U0 QueInit(CQue *head);
_intern IC_QUE_INS U0 QueIns(CQue *entry,CQue *pred);
_intern IC_QUE_REM U0 QueRem(CQue *entry);

//--------------------------------------------- switch
U0 Sw(I64 i)
{
  switch (i) {
    case 1: TPS("one"); break;
    case 2...4: TPS("two-four"); break;
    case 10:
    case 11: TPS("ten-eleven"); break;
    default: TPS("dft");
  }
}
Sw(1); Sw(3); Sw(4); Sw(11); Sw(7); Sw(-5);
//> one
//> two-four
//> two-four
//> ten-eleven
//> dft
//> dft

U0 SubSw(I64 i)
{
  switch (i) {
    case 0: TPS("zero"); break;
    start:
      TPS("start");
      case 1: TPS("a"); break;
      case 2: TPS("b"); break;
    end:
      TPS("end");
      break;
    case 3: TPS("three");
  }
}
SubSw(0); SubSw(1); SubSw(2); SubSw(3);
//> zero
//> start
//> a
//> end
//> start
//> b
//> end
//> three

U0 NbSw(I64 i)
{
  switch [i] {
    case: TPS("n0"); break;
    case: TPS("n1"); break;
    case: TPS("n2"); break;
  }
}
NbSw(0); NbSw(2);
//> n0
//> n2

//--------------------------------------------- loops, goto
I64 Loops()
{
  I64 i=0,j,res=0;
  while (i<5) {
    i++;
    if (i==2) continue_kludge: ;
    res+=i;
  }
  do {
    res*=2;
  } while (res<100);
  for (i=0;i<10;i++) {
    for (j=0;j<10;j++) {
      if (j==3) break;
      res++;
    }
    if (i==4) break;
  }
  i=0;
again:
  if (++i<4) goto again;
  return res+i;
}
TPI(Loops);
//> 139

//--------------------------------------------- pointers, arrays, classes
class CPt
{
  I64 x,y;
  U8 name[8];
};
class CPt3:CPt
{
  F64 z;
};
CPt3 g_pt;
I64 g_arr[3][4];

U0 Ptrs()
{
  I64 i,j,a[5],*p;
  U8 buf[16],*s;
  CPt3 pt,*pp=&pt;
  for (i=0;i<5;i++) a[i]=i*i;
  p=a;
  TPI(*p++);
  TPI(*p++);
  TPI(*++p);
  TPI(p[1]);
  TPI(p-a);
  pp->x=3; pp->y=4; pp->z=0.5;
  TPI(pt.x+pt.y);
  TPF(pp->z*2);
  s=buf;
  *s++='H'; *s++='i'; *s=0;
  TPS(buf);
  TPI(StrLen(buf));
  for (i=0;i<3;i++)
    for (j=0;j<4;j++)
      g_arr[i][j]=i*10+j;
  TPI(g_arr[2][3]+g_arr[1][1]);
  g_pt.x=7;
  TPI(g_pt.x);
  TPI(sizeof(CPt3));
  TPI(offset(CPt3.z));
  TPI(sizeof(g_arr));
}
Ptrs;
//> 0
//> 1
//> 9
//> 16
//> 3
//> 7
//> 1
//> Hi
//> 2
//> 34
//> 7
//> 32
//> 24
//> 96

//--------------------------------------------- function pointers, default/var args
I64 Add2(I64 a,I64 b=10) {return a+b;}
I64 Mul2(I64 a,I64 b) {return a*b;}
I64 (*g_fp)(I64 a,I64 b);
I64 SumArgs(I64 base,...)
{
  I64 i,res=base;
  for (i=0;i<argc;i++)
    res+=argv[i];
  return res;
}
U0 FunPtrs()
{
  I64 (*fp)(I64 a,I64 b);
  fp=&Mul2; //(TempleOS can't init a local fun ptr in its declaration)
  TPI(fp(6,7));
  g_fp=&Add2;
  TPI((*g_fp)(1,2));
  TPI(g_fp(5,5));
  TPI(Add2(5));
  TPI(SumArgs(100,1,2,3,4));
  TPI(SumArgs(1));
}
FunPtrs;
//> 42
//> 3
//> 10
//> 15
//> 110
//> 1

//--------------------------------------------- comparisons, logic
U0 Cmps(I64 i,F64 f)
{
  if (0<i<10) TPS("in"); else TPS("out");
  TPI(0<i<10);
  TPI(i>5 && i<20);
  TPI(i<5 || i>20);
  if (f>0.0) TPS("fpos");
  if (1.0<f<2.0) TPS("frange");
  TPI(f==1.5);
  TPI(!i);
  TPI(~i);
  TPI(i^^1);
}
Cmps(7,1.5);
Cmps(30,-1.0);
//> in
//> 1
//> 1
//> 0
//> fpos
//> frange
//> 1
//> 0
//> -8
//> 0
//> out
//> 0
//> 0
//> 1
//> 0
//> 0
//> -31
//> 0

//--------------------------------------------- intrinsics
U0 Intrinsics()
{
  I64 bits=0,i=10,j=20;
  U64 q=100;
  CQue head,e1,e2;
  Bts(&bits,3);
  LBts(&bits,40);
  TPI(bits);
  TPI(Bt(&bits,3));
  TPI(Btr(&bits,3));
  TPI(Bt(&bits,3));
  if (Bt(&bits,40)) TPS("bit40");
  TPI(ToUpper('q'));
  TPI(MaxI64(-3,2));
  TPI(MinU64(-1,5));
  TPI(ModU64(&q,7));
  TPI(q);
  TPI(SignI64(-9));
  TPI(AbsI64(-9));
  TPF(Sqr(1.5));
  TPF(Sqrt(2.25));
  TPI(Bsf(0x50));
  TPI(Bsr(0x50));
  TPI(Bsf(0));
  TPI(ToI64(-2.7));
  TPF(ToF64(3));
  SwapI64(&i,&j);
  TPI(i-j);
  QueInit(&head);
  QueIns(&e1,&head);
  QueIns(&e2,&head);
  TPI(head.next==&e2);
  TPI(e2.next==&e1);
  QueRem(&e2);
  TPI(head.next==&e1);
  TPF(2`10);
}
Intrinsics;
//> 1099511627784
//> 1
//> 1
//> 0
//> bit40
//> 81
//> 2
//> 5
//> 2
//> 14
//> -1
//> 9
//> 2.25
//> 1.5
//> 4
//> 6
//> -1
//> -2
//> 3
//> 10
//> 1
//> 1
//> 1
//> 1024

//--------------------------------------------- statics, globals, inits
I64 g_init=0x1234;
U8 *g_str="glbl str";
F64 g_f=2.5;
I64 g_tab[4]={10,20,30,40};
U8 g_msg[4]="arr"; //([] arrays have size 0 in this compiler source)
I64 Counter()
{
  static I64 cnt=100;
  return cnt++;
}
U0 Statics()
{
  TPI(g_init);
  TPS(g_str);
  TPF(g_f);
  TPI(g_tab[2]);
  TPS(g_msg);
  TPI(sizeof(g_msg));
  Counter; Counter;
  TPI(Counter);
}
Statics;
//> 4660
//> glbl str
//> 2.5
//> 30
//> arr
//> 4
//> 102

//--------------------------------------------- unions, casts
U0 Casts()
{
  I64 i=0x3FF0000000000000;
  F64 f;
  U16 w;
  f=i(F64);
  TPF(f);
  TPI(f(I64));
  w=0x1234;
  TPI(w.u8[0]);
  TPI(w.u8[1]);
  i=-1;
  TPI(i.u32[1]);
  TPI(i.i8[0]);
  TPI(1.9(I64));
  TPI(ToI64(1.9));
}
Casts;
//> 1
//> 4607182418800017408
//> 52
//> 18
//> 4294967295
//> -1
//> 4611235658464650855
//> 1
