#help_index "TextBase Layer;Char/TextBase Layer"
#help_file "::/Doc/TextBase"

//WebTempleOS port: the TextBase asm in HolyC, step by step as the asm did.

I64 PortTextClipX(CTask *task,I64 *_x,I64 *_len,I64 *_skip)
{//The x clipping the TEXT_LEN_* routines share.  Returns the clipped len.
  I64 rdi=*_x+task->scroll_x>>3,rcx=*_len,rdx,rax,skip=0;
  if (rdi<0) {
    rcx+=rdi;
    skip-=rdi;
    rdi=0;
  }
  rdi+=task->win_left;
  rdx=rcx+rdi-1;
  if (rdx>task->win_right) {
    rax=rdx-task->win_right;
    rdx-=rax;
    rcx-=rax;
  }
  if (rdi<0) {
    rcx+=rdi;
    skip-=rdi;
    rdi=0;
  }
  rdx++;
  rdx-=TEXT_COLS;
  if (rdx>0)
    rcx-=rdx;
  *_x=rdi;
  *_skip=skip;
  return rcx;
}

U32 *PortTextRow(CTask *task,I64 x,I64 y)
{//The y clipping: NULL if off screen, else the text_base addr of x,y.
  y+=task->scroll_y>>3;
  if (y<0) return NULL;
  y+=task->win_top;
  if (y>task->win_bottom || y<0 || y>=TEXT_ROWS)
    return NULL;
  return gr.text_base+y*TEXT_COLS+x;
}

public Bool TextChar(CTask *task,Bool allow_border=FALSE,I64 x,I64 y,I64 d)
{//Plot char. 30fps in Fs->draw_it() callback.
  x+=task->scroll_x>>3;
  y+=task->scroll_y>>3;
  if (!allow_border) {
    if (x<0) return FALSE;
    x+=task->win_left;
    if (x>task->win_right || x<0 || x>=TEXT_COLS) return FALSE;
    if (y<0) return FALSE;
    y+=task->win_top;
    if (y>task->win_bottom || y<0 || y>=TEXT_ROWS) return FALSE;
  } else {
    if (x<-1) return FALSE;
    x+=task->win_left;
    if (x>task->win_right+1 || x<0 || x>=TEXT_COLS) return FALSE;
    if (y<-1) return FALSE;
    y+=task->win_top;
    if (y>task->win_bottom+1 || y<0 || y>=TEXT_ROWS) return FALSE;
  }
  gr.text_base[y*TEXT_COLS+x]=d;
  return TRUE;
}

public Bool TextLenStr(CTask *task,I64 x,I64 y,I64 len,I64 attr,U8 *s)
{//Plot str with len.  30fps in Fs->draw_it() callback.
  I64 skip;
  U32 *dst;
  if ((len=PortTextClipX(task,&x,&len,&skip))<1 ||
	!(dst=PortTextRow(task,x,y)))
    return FALSE;
  s+=skip;
  attr&=~0xFF;
  while (len--)
    *dst++=attr|*s++;
  return TRUE;
}

public Bool TextLenAttrStr(CTask *task,I64 x,I64 y,I64 len,U32 *_attr)
{//Plot attr str with len.	30fps in Fs->draw_it() callback.
  I64 skip;
  U32 *dst;
  if ((len=PortTextClipX(task,&x,&len,&skip))<1 ||
	!(dst=PortTextRow(task,x,y)))
    return FALSE;
  _attr+=skip;
  while (len--)
    *dst++=*_attr++;
  return TRUE;
}

public Bool TextLenAttr(CTask *task,I64 x,I64 y,I64 len,I64 attr)
{//Plot attrs with len.  30fps in Fs->draw_it() callback.
  I64 skip;
  U32 *dst;
  if ((len=PortTextClipX(task,&x,&len,&skip))<1 ||
	!(dst=PortTextRow(task,x,y)))
    return FALSE;
  while (len--) {
    if (*dst&0xFF)
      break;
    *dst++=attr;
  }
  return TRUE;
}

public U0 TextPrint(CTask *task,I64 x,I64 y,I64 attr,U8 *fmt,...)
{//Plot chars. 30fps in Fs->draw_it() callback.
//You probably want $LK,"GrPrint",A="MN:GrPrint"$() or just $LK,"Print",A="MN:Print"$().
  U8 *buf=StrPrintJoin(NULL,fmt,argc,argv);
  TextLenStr(task,x,y,StrLen(buf),attr<<8,buf);
  Free(buf);
}

public U0 TextBorder(CTask *task=NULL,
	I64 l,I64 r,I64 t,I64 b,I64 attr,Bool solid)
{//Plot border square. 30fps in Fs->draw_it() callback.
//Draws window borders or DolDoc text bttn borders.
  //Set task=sys_winmgr_task for no clipping.
  I64 i;
  if (!task) task=Fs;
  attr<<=8;
  TextChar(task,,l-1,t-1,text.border_chars[6+solid]+attr);
  TextChar(task,,r+1,t-1,text.border_chars[8+solid]+attr);
  TextChar(task,,l-1,b+1,text.border_chars[10+solid]+attr);
  TextChar(task,,r+1,b+1,text.border_chars[12+solid]+attr);
  for (i=l;i<=r;i++) {
    TextChar(task,,i,t-1,text.border_chars[2+solid]+attr);
    TextChar(task,,i,b+1,text.border_chars[2+solid]+attr);
  }
  for (i=t;i<=b;i++) {
    TextChar(task,,l-1,i,text.border_chars[4+solid]+attr);
    TextChar(task,,r+1,i,text.border_chars[4+solid]+attr);
  }
}

public U0 TextRect(I64 l,I64 r,I64 t,I64 b,I64 d)
{//Fill text rect. 30fps in Fs->draw_it() callback.
  I64 y,w;
  if (l>r || t>b) return;
  if (t<0) t=0;
  if (b>=TEXT_ROWS) b=TEXT_ROWS-1;
  if (l<0) l=0;
  if (r>=TEXT_COLS) r=TEXT_COLS-1;
  if (w=r-l+1)
    for (y=t;y<=b;y++)
      MemSetU32(gr.text_base(U8 *)+(y*TEXT_COLS+l)*sizeof(U32),d,w);
}

