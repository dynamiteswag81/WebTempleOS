//Backend tests from kernel heap code (Mem/MemPag.HC shapes).
#include "/Kernel/KernelA.HH"
_extern __TPI U0 TPI(I64 i);

class CUnused
{
  CUnused *next;
  I64 size;
};

class CHc
{
  CUnused *malloc_free_lst;
  CUnused *heap_hash[16];
};

CHc hc_test;
CUnused u1,u2,u3;

I64 Tidy(CHc *hc)
{//The tidy loop of MemPagTaskAlloc().
  I64 threshold,cnt,size,loops=0;
  CUnused *uum,**_uum,**_ptr;
  threshold=32;
  do {
    cnt=0;
    _uum=&hc->malloc_free_lst;
    while (uum=*_uum) {
      if (++loops>100) return -1;
      size=uum->size;
      if (size<threshold) {
	*_uum=uum->next;
	_ptr=(&hc->heap_hash)(U8 *)+size;
	uum->next=*_ptr;
	*_ptr=uum;
      } else {
	cnt++;
	_uum=uum;
      }
    }
    threshold<<=1;
  } while (cnt>8 && threshold<=128);
  return loops;
}

hc_test.malloc_free_lst=&u1;
u1.next=NULL; u1.size=0x1f90;
TPI(Tidy(&hc_test));
//> 1
u1.next=&u2; u1.size=8; u2.next=&u3; u2.size=100; u3.next=NULL; u3.size=16;
hc_test.malloc_free_lst=&u1;
TPI(Tidy(&hc_test));
//> 3
TPI(hc_test.malloc_free_lst==&u2);
//> 1
TPI(hc_test.heap_hash[1]==&u1);
//> 1
TPI(hc_test.heap_hash[2]==&u3);
//> 1

I64 SwCont(I64 n)
{//A case label threaded back to the loop head (switch target before it).
  I64 res=0;
again:
  if (n-->0) {
    switch (n%3) {
      case 0: goto again;
      case 1: res+=10; break;
      case 2: res+=100; break;
    }
    res++;
    goto again;
  }
  return res;
}
TPI(SwCont(6));
//> 224
