#!/bin/sh
# Fetch the TempleOS source tree this port is built from into
# vendor/TempleOS (gitignored).  The compiler maps drive C: to it, with
# port/ overlaid on top.  Pinned to the commit the port was written against.
set -e
cd "$(dirname "$0")/.."
REPO=https://github.com/cia-foundation/TempleOS
REV=c26482bb6ad3f80106d28504ec5db3c6a360732c
if [ -d vendor/TempleOS/Kernel ]; then
  echo "vendor/TempleOS already present"
  exit 0
fi
mkdir -p vendor
git clone -q -c core.autocrlf=false "$REPO" vendor/TempleOS
git -C vendor/TempleOS -c advice.detachedHead=false checkout -q "$REV"
echo "vendor/TempleOS at $REV"
