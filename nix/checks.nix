# CI-runnable checks exposed via `nix flake check`.
# These build derivations that run lint, typecheck, and tests
# in a hermetic Nix environment.
{
  pkgs,
  src,
}: let
  # Shared build setup: copy source tree and install deps
  mkCheck = {
    name,
    checkScript,
  }:
    pkgs.stdenv.mkDerivation {
      inherit name;
      src = pkgs.lib.cleanSource src;

      nativeBuildInputs = with pkgs; [
        nodejs_24
        pnpm
        cacert # needed for pnpm to fetch packages over HTTPS
      ];

      # pnpm needs a writable home for its store
      HOME = "$TMPDIR";

      buildPhase = ''
        export PNPM_HOME="$TMPDIR/.pnpm"
        mkdir -p "$PNPM_HOME"

        # Configure pnpm store inside the build sandbox
        pnpm config set store-dir "$TMPDIR/.pnpm-store"

        # Install dependencies
        pnpm install --frozen-lockfile

        # Run the actual check
        ${checkScript}
      '';

      installPhase = ''
        # Nix requires an output — touch a marker file
        mkdir -p $out
        touch $out/.check-passed
      '';
    };
in {
  lint = mkCheck {
    name = "vinext-lint";
    checkScript = "pnpm run lint";
  };

  typecheck = mkCheck {
    name = "vinext-typecheck";
    checkScript = "pnpm run typecheck";
  };

  test = mkCheck {
    name = "vinext-test";
    checkScript = ''
      pnpm run build
      pnpm test
    '';
  };
}
