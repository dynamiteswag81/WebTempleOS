//WebTempleOS port: the KHashA asm as HolyC.
extern U0 HashDel(CHashSrcSym *tmph);
_extern _HASH_STR I64 HashStr(U8 *st);
_extern _HASH_BUCKET_FIND CHash **HashBucketFind(U8 *needle_str,
	CHashTable *haystack_table);

I64 _HashStr(U8 *st)
{//rbx=rbx<<1+carry+ch, then rbx+rbx>>16+carry, as SHL1/ADC did.
  U64 res=0,ch;
  if (!st) return 0;
  while (ch=*st++)
    res=(res<<1)+(res>>63)+ch;
  return res+(res>>16)+((res>>15)&1);
}

CHash *PortHashSingleFind(I64 h,U8 *needle_str,I64 mask,CHashTable *table,
	I64 *_instance,CHash ***_link=NULL)
{//SYS_HASH_SINGLE_TABLE_FIND: *_instance counts down over matches,
//like RCX did, also across tables in $LK,"HashFind",A="MN:HashFind"$().
  CHash **link,*tmph;
  if (!*_instance) return NULL;
  link=&table->body[h&table->mask];
  while (tmph=*link) {
    if (tmph->type&mask && !StrCmp(tmph->str,needle_str) && !--*_instance) {
      tmph->use_cnt++;
      if (_link) *_link=link;
      return tmph;
    }
    link=&tmph->next;
  }
  return NULL;
}

CHash *_HashFind(U8 *needle_str,CHashTable *haystack_table,
	I64 mask,I64 instance=1)
{
  I64 h=HashStr(needle_str);
  CHash *res;
  while (haystack_table) {
    if (res=PortHashSingleFind(h,needle_str,mask,haystack_table,&instance))
      return res;
    haystack_table=haystack_table->next;
  }
  return NULL;
}

CHash *_HashSingleTableFind(U8 *needle_str,CHashTable *haystack_table,
	I64 mask,I64 instance=1)
{
  return PortHashSingleFind(HashStr(needle_str),needle_str,mask,
	haystack_table,&instance);
}

CHash **_HashBucketFind(U8 *needle_str,CHashTable *haystack_table)
{
  return &haystack_table->body[HashStr(needle_str)&haystack_table->mask];
}

U0 _HashAdd(CHash *tmph,CHashTable *table)
{
  CHash **bucket=HashBucketFind(tmph->str,table);
  PUSHFD
  CLI
  tmph->next=*bucket;
  *bucket=tmph;
  POPFD
}

U0 _HashAddAfter(CHash *tmph,CHash *pred,CHashTable *table)
{//pred's next field is at offset zero, so it is a link.
  no_warn table;
  PUSHFD
  CLI
  tmph->next=pred->next;
  pred->next=tmph;
  POPFD
}

Bool _HashRemDel(CHash *tmph,CHashTable *table,I64 instance=1)
{
  CHash *res,**link;
  if (!tmph) return FALSE;
  PUSHFD
  CLI
  res=PortHashSingleFind(HashStr(tmph->str),tmph->str,
	tmph->type&~HTG_FLAGS_MASK&0xFFFFFFFF,table,&instance,&link);
  if (res && res==tmph) {
    *link=res->next;
    POPFD
    HashDel(res);
    return TRUE;
  }
  POPFD
  return FALSE;
}

_extern _HASH_STR I64 HashStr(U8 *st); //Hash a string.
_extern _HASH_FIND CHash *HashFind(U8 *needle_str,CHashTable *haystack_table,
	I64 mask,I64 instance=1);//Find string in hash table.
_extern _HASH_SINGLE_TABLE_FIND CHash *HashSingleTableFind(U8 *needle_str,
	CHashTable *haystack_table,
	I64 mask,I64 instance=1);//Find string in single hash table.
_extern _HASH_BUCKET_FIND CHash **HashBucketFind(U8 *needle_str,
	CHashTable *haystack_table); //Find hash bucket.
_extern _HASH_ADD U0 HashAdd(CHash *tmph,
	CHashTable *table); //Add entry to hash table.
_extern _HASH_REM_DEL Bool HashRemDel(CHash *tmph,CHashTable *table,
	I64 instance=1);//Remove hash entry and del. Instance must match.
