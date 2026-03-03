{
  description = "vinext — Vite plugin reimplementing the Next.js API surface";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    # Backward compatibility for non-flake users (shell.nix)
    flake-compat = {
      url = "github:edolstra/flake-compat";
      flake = false;
    };
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
    ...
  }:
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = nixpkgs.legacyPackages.${system};
      in {
        devShells.default = pkgs.callPackage ./nix/devShell.nix {};

        formatter = pkgs.nixfmt;
      }
    );

  # To update pinned dependencies: nix flake update
}
