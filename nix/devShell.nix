{
  mkShell,
  lib,
  stdenv,
  nodejs_24,
  pnpm,
  oxlint,
  playwright-driver,
  gh,
  jq,
  nixfmt,
}:
mkShell {
  name = "vinext";

  packages =
    [
      # Runtime
      nodejs_24

      # Package manager — matches packageManager field in package.json
      pnpm

      # Linting (matches pnpm run lint)
      oxlint

      # Nix formatting
      nixfmt

      # Utilities
      gh # GitHub CLI — used in AGENTS.md workflow (gh search code)
      jq
    ]
    ++ lib.optionals stdenv.hostPlatform.isLinux [
      # Playwright system dependencies on Linux
      playwright-driver.browsers
    ];

  env =
    {
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
    }
    // lib.optionalAttrs stdenv.hostPlatform.isLinux {
      # Tell Playwright to use Nix-provided browser binaries on Linux
      PLAYWRIGHT_BROWSERS_PATH = "${playwright-driver.browsers}";
    };

  shellHook = ''
    echo "🚀 vinext dev shell"
    echo "   Node.js $(node --version)"
    echo "   pnpm $(pnpm --version)"
    echo ""

    # Install dependencies if node_modules is missing or stale
    if [ ! -d node_modules ] || [ package.json -nt node_modules/.package-lock.json ] 2>/dev/null; then
      echo "📦 Running pnpm install..."
      pnpm install --frozen-lockfile
    fi
  '';
}
