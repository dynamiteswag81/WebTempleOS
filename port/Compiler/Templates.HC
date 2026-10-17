//WebTempleOS port: the x86 code templates are only used by the x86
//back-end (OptPass789A), which the wasm back-end replaces.  The labels
//stay, so $LK,"CExts",A="FI:::/Compiler/CExts.HC"$ still binds.
asm {
CMP_TEMPLATES::
CMP_TEMPLATES_DONT_POP::
CMP_TEMPLATES_DONT_PUSH::
CMP_TEMPLATES_DONT_PUSH_POP::
CMP_TEMPLATES_DONT_PUSH2::
	DU32	0;
}
