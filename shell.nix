# Backward compatibility for users without flake support.
# Prefer `nix develop` if your Nix installation supports flakes.
(import (fetchTarball "https://github.com/edolstra/flake-compat/archive/master.tar.gz") {
  src = ./.;
})
.shellNix
