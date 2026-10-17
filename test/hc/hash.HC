//Backend tests from the kernel hash code (port/Kernel/KHashA.HC shapes).
//Note: HolyC parses --*p as *(--p), as TempleOS's compiler does.
#include "/Kernel/KernelA.HH"
_extern __TPI U0 TPI(I64 i);

class CH
{
  CH *next;
  U8 *str;
  U32 type,use_cnt;
};
class CHT
{
  CHT *next;
  I64 mask,locked_flags;
  CH **body;
};

I64 MyStrCmp(U8 *st1,U8 *st2)
{
  I64 ch1,ch2;
  while (TRUE) {
    ch1=*st1++;
    ch2=*st2++;
    if (ch1!=ch2) {
      if (ch2>ch1)
	return -1;
      else
	return 1;
    }
    if (!ch2) return 0;
  }
}

CH *SingleFind(I64 h,U8 *needle_str,I64 mask,CHT *table,
	I64 *_instance,CH ***_link=NULL)
{
  CH **link,*tmph;
  if (!*_instance) return NULL;
  link=&table->body[h&table->mask];
  while (tmph=*link) {
    if (tmph->type&mask && !MyStrCmp(tmph->str,needle_str) && !(*_instance-=1)) {
      tmph->use_cnt++;
      if (_link) *_link=link;
      return tmph;
    }
    link=&tmph->next;
  }
  return NULL;
}

CH *Find(U8 *needle_str,CHT *haystack_table,I64 mask,I64 instance=1)
{
  I64 h=5;
  CH *res;
  while (haystack_table) {
    if (res=SingleFind(h,needle_str,mask,haystack_table,&instance))
      return res;
    haystack_table=haystack_table->next;
  }
  return NULL;
}

CH e1,e2;
CH *bdy[8];
CHT tbl;
U0 HashTest()
{
  tbl.mask=7;
  tbl.body=bdy;
  e1.str="ST_DRV_TYPES";
  e1.type=4;
  e1.next=&e2;
  e2.str="ST_COLORS";
  e2.type=4;
  bdy[5]=&e1;
  TPI(MyStrCmp("ST_DRV_TYPES","ST_DRV_TYPES"));
  TPI(Find("ST_DRV_TYPES",&tbl,4)==&e1);
  TPI(Find("ST_COLORS",&tbl,4)==&e2);
  TPI(Find("ST_COLORS",&tbl,8)==NULL);
  TPI(e1.use_cnt);
}
HashTest;
//> 0
//> 1
//> 1
//> 1
//> 1
