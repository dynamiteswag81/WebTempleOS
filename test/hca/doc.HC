//Adam-level tests (test/jit.mjs -adam): DolDoc.
CDoc *doc=DocRead("::/Demo/Graphics/SpritePlot.HC");
TPI(QueCnt(&doc->bin_head)>0);
//> 1
doc=DocRead("::/PersonalMenu.DD");
TPI(QueCnt(&doc->bin_head)>0);
//> 1
