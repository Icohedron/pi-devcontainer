{ pkgs, ... }:

{
  # Generates .devcontainer/devcontainer.json. That generated config is also the
  # fixture the integration tests run against, so devenv defines both the dev
  # shell and the container under test.
  devcontainer.enable = true;

  # Node from nix. On WSL a bare `npm` otherwise resolves to Windows npm, which
  # runs Windows node and mangles paths ("Cannot find module C:\Windows\...").
  # Node 24 is required: the extension and its tests rely on native TypeScript
  # type stripping and path.posix.matchesGlob.
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    npm.enable = true;
  };

  scripts = {
    # pi supplies @earendil-works/* to extensions at load time, so they are
    # peerDependencies here, not vendored copies. Link them in for direct
    # `node test/...` runs.
    #
    # Prefer the unresolved path next to the `pi` on PATH (for a nix profile
    # install that is ~/.nix-profile/lib/..., which follows upgrades on its
    # own). Only fall back to the fully resolved, version-pinned store path,
    # which goes stale on `pi update` and dangles after a nix GC.
    pi-link-deps.exec = ''
      set -euo pipefail
      pi_bin="$(command -v pi || true)"
      if [ -z "$pi_bin" ]; then
        echo "pi-link-deps: pi is not on PATH" >&2
        exit 1
      fi

      monorepo=""
      for candidate in \
        "$(dirname "$pi_bin")/../lib/node_modules/pi-monorepo" \
        "$(dirname "$(readlink -f "$pi_bin")")/../lib/node_modules/pi-monorepo" \
        "$(dirname "$(readlink -f "$pi_bin")")/../lib/node_modules/@earendil-works/pi-coding-agent"
      do
        if [ -f "$candidate/package.json" ]; then
          monorepo="$candidate"
          break
        fi
      done

      if [ -z "$monorepo" ]; then
        echo "pi-link-deps: could not locate the pi package next to $pi_bin" >&2
        exit 1
      fi

      mkdir -p "$DEVENV_ROOT/node_modules/@earendil-works"
      ln -sfn "$monorepo" "$DEVENV_ROOT/node_modules/@earendil-works/pi-coding-agent"
      ln -sfn "$monorepo/node_modules/@earendil-works/pi-tui" \
              "$DEVENV_ROOT/node_modules/@earendil-works/pi-tui"

      linked="$(node -p "require(\"$monorepo/package.json\").version" 2>/dev/null || echo unknown)"
      running="$(pi --version 2>/dev/null | head -1 || echo unknown)"
      echo "linked @earendil-works/{pi-coding-agent,pi-tui} $linked -> $monorepo"
      if [ "$linked" != "$running" ] && [ "$running" != "unknown" ]; then
        echo "pi-link-deps: warning: linked $linked but pi on PATH is $running" >&2
      fi
    '';

    # Checks that need neither a container runtime nor a running container.
    pi-check.exec = ''
      set -euo pipefail
      cd "$DEVENV_ROOT"
      echo "==> discovery and JSONC unit tests"
      node test/test-discovery.ts
      echo "==> config merge tests"
      node test/test-config.ts
      echo "==> host command security"
      node test/test-security.ts
      echo "==> host command routing"
      node test/test-routing.ts
      echo "==> module load check"
      # Always re-link: a link made earlier can be stale or dangling after a
      # pi upgrade or a nix garbage collection.
      if command -v pi >/dev/null 2>&1; then
        pi-link-deps
        node -e 'import("./src/index.ts").then(m => {
          if (typeof m.default !== "function") { console.error("src/index.ts has no default export"); process.exit(1); }
          console.log("  src/index.ts loads and exports an extension factory");
        }).catch(e => { console.error(e); process.exit(1); })'
      else
        echo "  skipped: pi is not on PATH, so there is nothing to link against"
      fi
    '';

    # Full suite. Needs this repository's devcontainer to be running.
    pi-test.exec = ''
      set -euo pipefail
      cd "$DEVENV_ROOT"
      pi-link-deps
      echo "==> unit tests"
      node test/test-discovery.ts
      echo "==> config and runtime wiring"
      node test/test-config.ts
      echo "==> host command security"
      node test/test-security.ts
      echo "==> host command routing"
      node test/test-routing.ts
      echo "==> container operations"
      node test/test-harness.ts
      echo "==> escape attempts"
      node test/test-escape.ts
      echo "==> extension, routing on"
      node test/test-extension.ts container
      echo "==> extension, --no-devcontainer"
      node test/test-extension.ts disabled
      echo "==> extension, requireContainer"
      node test/test-extension.ts strict
      echo "==> extension, started in a subdirectory"
      node test/test-extension.ts nested
      echo "==> menu, status bar and toggle"
      node test/test-menu.ts
      echo "==> extension, host fallback"
      tmp="$(mktemp -d)"
      echo on-the-host > "$tmp/host-marker.txt"
      (cd "$tmp" && node "$DEVENV_ROOT/test/test-extension.ts" host)
      rm -rf "$tmp"
    '';

    # Start this repository's devcontainer so the integration suites can run.
    pi-container-up.exec = ''
      set -euo pipefail
      exec devcontainer up --workspace-folder "$DEVENV_ROOT"
    '';
  };

  enterShell = ''
    echo "pi-devcontainer  node $(node --version)  npm $(npm --version)"
    echo "  pi-link-deps      link pi peer deps into ./node_modules"
    echo "  pi-check          unit tests only (no container needed)"
    echo "  pi-test           full suite (needs a running devcontainer)"
    echo "  pi-container-up   start the devcontainer"
  '';

  # `devenv test` runs on the host and, via updateContentCommand, inside the
  # container. Only the container-free checks are unconditional so the
  # in-container run cannot fail for lack of docker/podman.
  enterTest = ''
    set -euo pipefail
    cd "$DEVENV_ROOT"

    echo "node $(node --version) from $(command -v node)"
    echo "npm  $(npm --version) from $(command -v npm)"

    pi-check

    if [ -n "''${PI_DEVCONTAINER_SKIP_INTEGRATION:-}" ]; then
      echo "==> integration suites skipped (PI_DEVCONTAINER_SKIP_INTEGRATION set)"
    elif container_name="$(node dev/container-status.ts 2>/dev/null)"; then
      echo "==> integration suites against container $container_name"
      pi-test
    else
      echo "==> integration suites skipped: $(node dev/container-status.ts 2>&1 >/dev/null || true)"
      echo "    run pi-container-up on the host, then devenv test"
    fi
  '';
}
