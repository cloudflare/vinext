#!/usr/bin/env bash
set -euo pipefail

sed \
  -e '/deprecated subdependencies found:/d' \
  -e '/\[DEP0169\] DeprecationWarning:/d' \
  -e '/Use `node --trace-deprecation/d'
