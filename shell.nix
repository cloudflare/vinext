# Backward compatibility for users without flake support.
# Prefer `nix develop` if your Nix installation supports flakes.
#
# Pinned to the same flake-compat rev as in flake.lock for reproducibility.
(import (fetchTarball "https://github.com/edolstra/flake-compat/archive/5edf11c44bc78a0d334f6334cdaf7d60d732daab.tar.gz") {
  src = ./.;
})
.shellNix
