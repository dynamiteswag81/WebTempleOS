#help_index "Graphics/Misc"
//WebTempleOS port: the GrAsm routines in HolyC, doing what the asm did.

U0 GrRopEquU8NoClipping(I64 ch,U8 *dst,I64 width_internal)
{//Puts foreground char shape onto gr.dc2.
//ch.u8[1] is color as a whole byte
//ch ATTRf_UNDERLINE attr flag is used.
  I64 i,m,c;
  U64 font=text.font[ch&255];
  if (Bt(&ch,ATTRf_UNDERLINE))
    font|=0xFF00000000000000;
  if (!font) return;
  c=gr.to_8_colors[ch.u8[1]];
  for (i=0;i<8;i++) {
    m=gr.to_8_bits[font&255];
    font>>=8;
    *dst(I64 *)=*dst(I64 *)&~m|c&m;
    dst+=width_internal;
  }
}

public Bool IsPixCovered0(CTask *task,I64 x,I64 y)
{//No clipping
#assert FONT_WIDTH==FONT_HEIGHT==8
  return task->win_z_num<gr.win_z_buf[(y>>3)*TEXT_COLS+x>>3];
}

U0 GrUpdateLine64(U64 **_vga,U64 **_src,I64 d,U8 **_dst)
{
  U64 *src=*_src,*image=*_dst,*vga=*_vga,v;
  I64 i;
  while (d--) {
    v=*src++;
    if (*image!=v) {
      *image=v;
      for (i=0;i<8;i++)
	v.u8[i]=rev_bits_table[v.u8[i]];
      *vga=v;
    }
    image++;
    vga++;
  }
  *_vga=vga;
  *_dst=image;
  *_src=src;
}

U0 GrUpdateLine64FlushCache(U64 **_vga,U64 **_src,I64 d,U8 **_dst)
{
  U64 *src=*_src,*image=*_dst,*vga=*_vga,v;
  I64 i;
  while (d--) {
    v=*src++;
    *image++=v;
    for (i=0;i<8;i++)
      v.u8[i]=rev_bits_table[v.u8[i]];
    *vga++=v;
  }
  *_vga=vga;
  *_dst=image;
  *_src=src;
}

U0 DCBlotColor4(U8 *dst,I64 *img,I64 *img_cache,I64 cnt)
{//Each U64 of img is 8 pixels of 4-bit color; bit p of each one goes to
//plane p (dst+p*cnt), the first pixel in the high bit.
  I64 i,p,k,v,b;
  for (i=0;i<cnt;i++) {
    v=*img++;
    if (v!=*img_cache) {
      *img_cache=v;
      for (p=0;p<4;p++) {
	b=0;
	for (k=7;k>=0;k--)
	  b=b<<1+Bt(&v,k*8+p);
	dst[p*cnt+i]=b;
      }
    }
    img_cache++;
  }
}
