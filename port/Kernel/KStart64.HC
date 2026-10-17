//WebTempleOS port of KStart64.HC.
//The 64-bit start-up (CPU0 struct, Adam's heap ctrl, TaskInit, jump to
//KMain) is $LK,"KStartWasm",A="MN:KStartWasm"$() in KMain.HC, which the JS boot loader calls.
//SYS_ENTER_LONG_MODE and SYS_RAM_REBOOT have no wasm equivalent.
