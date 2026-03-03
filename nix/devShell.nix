{
  mkShell,
  lib,
  stdenv,
  nodejs_24,
  oxlint,
  gh,
  jq,
  nixfmt,
}:
mkShell {
  name = "vinext";

  packages =
    [
      # Runtime — Node.js 24 ships with corepack, which reads the
      # packageManager field from package.json to install the exact
      # pnpm version the project declares (e.g. pnpm@10.30.0).
      nodejs_24

      # Linting (matches pnpm run lint)
      oxlint

      # Nix formatting
      nixfmt

      # Utilities
      gh # GitHub CLI — used in AGENTS.md workflow (gh search code)
      jq
    ];

  env = {
    # Let Playwright manage its own browser binaries via pnpm.
    # Nix-provided playwright-driver.browsers would version-couple to nixpkgs
    # and likely mismatch the @playwright/test version in package.json.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "0";

    # Allow corepack to download the pnpm version specified in packageManager
    # without an interactive confirmation prompt (which hangs in non-TTY shells).
    COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
  };

  shellHook = ''
    # Corepack is bundled with Node.js but needs a writable directory for
    # its shims since the Nix store is read-only. We create a local bin
    # directory and prepend it to PATH.
    COREPACK_INSTALL_DIR="$PWD/.corepack/bin"
    mkdir -p "$COREPACK_INSTALL_DIR"
    export PATH="$COREPACK_INSTALL_DIR:$PATH"
    corepack enable --install-directory "$COREPACK_INSTALL_DIR" 2>/dev/null

    echo "🚀 vinext dev shell"
    echo "   Node.js $(node --version)"
    echo "   pnpm $(pnpm --version 2>/dev/null || echo '(downloading...)')"
    echo ""

    # Install dependencies if node_modules is missing or lockfile has changed.
    # pnpm uses .modules.yaml (not npm's .package-lock.json).
    if [ ! -d node_modules ] || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ] 2>/dev/null; then
      echo "📦 Running pnpm install..."
      pnpm install --frozen-lockfile
    fi
  '';
}
