#!/usr/bin/env bash
set -euo pipefail

awk '
  /^> .* (preinstall|install|postinstall)( |$)/ {
    in_lifecycle_script = 1
  }

  in_lifecycle_script && /^Done in .* using pnpm v[0-9]/ {
    in_lifecycle_script = 0
    print
    next
  }

  !in_lifecycle_script && /deprecated subdependencies found:/ {
    next
  }

  !in_lifecycle_script && /\[DEP0169\] DeprecationWarning: .*url\.parse\(\)/ {
    skipped_node_warning = 1
    next
  }

  !in_lifecycle_script && skipped_node_warning && /^\(Use `node --trace-deprecation .*` to show where the warning was created\)$/ {
    skipped_node_warning = 0
    next
  }

  {
    skipped_node_warning = 0
    print
  }
'
