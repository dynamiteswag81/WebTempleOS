//Backend unit tests: each top-level statement runs in order (IET_MAIN).
//Expected output lines follow //> markers.
#include "/Kernel/KernelA.HH"
#include "/Compiler/CompilerA.HH"
_extern __TPI U0 TPI(I64 i);
_extern __TPF U0 TPF(F64 d);
_extern __TPS U0 TPS(U8 *s);

I64 Fib(I64 n)
{
  if (n<2) return n;
  return Fib(n-1)+Fib(n-2);
}
TPI(Fib(20));
//> 6765

I64 Sum(I64 n)
{
  I64 i,res=0;
  for (i=1;i<=n;i++)
    res+=i;
  return res;
}
TPI(Sum(100));
//> 5050

TPS("Hello, God's temple");
//> Hello, God's temple

U0 Types()
{
  U8 b=255;
  I8 c=-1;
  U16 w=0xFFFF;
  I32 d=-2;
  F64 f=1.5;
  b++;
  TPI(b);
  TPI(c);
  TPI(w+1);
  TPI(d*3);
  TPF(f*4);
  TPI(f*4);
  TPF(7/2);
  TPI(-7/2);
  TPI(-7%3);
  TPI(7>>1);
  TPI(-8>>1);
  TPI(1<<40);
}
Types;
//> 0
//> -1
//> 65536
//> -6
//> 6
//> 6
//> 3
//> -3
//> -1
//> 3
//> -4
//> 1099511627776

_intern IC_TO_I64 I64 ToI64(F64 d);
F64 neg_f=-2.7;
TPI(ToI64(neg_f)); //f2i of a negative (not constant-folded)
//> -2
