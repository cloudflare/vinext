{
  mkShell,
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
    # Allow corepack to download the pnpm version specified in packageManager
    # without an interactive confirmation prompt (which hangs in non-TTY shells).
    COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";

    # Playwright browser downloads are left at their default (enabled).
    # We intentionally do NOT use Nix-provided playwright-driver.browsers
    # because its version would couple to nixpkgs and likely mismatch the
    # @playwright/test version in package.json, causing runtime failures.
    #
    # Note: on NixOS or in --pure Nix shells, Playwright also needs system
    # libraries (GTK3, ALSA, libdrm, etc.) that are not provided here.
    # E2E tests work on standard Linux/macOS where these libraries are
    # available from the host. For NixOS, you may need to wrap the Playwright
    # binary with the required library paths or use a FHS environment.
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
    if [ ! -d node_modules ] || { [ -f pnpm-lock.yaml ] && [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; }; then
      echo "📦 Running pnpm install..."
      pnpm install --frozen-lockfile || echo "⚠️  pnpm install failed. Run it manually to see the full error."
    fi
  '';
}
