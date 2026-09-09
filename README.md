# pi-devcontainer

A [pi](https://pi.dev) extension that routes pi's built-in tool calls into your
project's devcontainer instead of running them on the host.

## Install

```bash
pi install git:github.com/Icohedron/pi-devcontainer          # global (all projects)
pi install -l git:github.com/Icohedron/pi-devcontainer       # this project only
pi install git:github.com/Icohedron/pi-devcontainer@v0.1.0   # pin a tag
```

Try it for a single run without installing:

```bash
pi -e git:github.com/Icohedron/pi-devcontainer
```

From a local checkout:

```bash
pi install -l /path/to/pi-devcontainer   # add to this project's settings
pi -e /path/to/pi-devcontainer           # one run only
```

Remove with `pi remove git:github.com/Icohedron/pi-devcontainer` (add `-l` for
project settings).

## What it does

On startup the extension walks up from the working directory and uses the first
devcontainer configuration it finds. The first two are the locations the
devcontainer CLI itself auto-discovers:

1. `<dir>/.devcontainer/devcontainer.json`
2. `<dir>/.devcontainer.json`

As a fallback it also checks `<dir>/.devcontainer/<folder>/devcontainer.json`,
the layout VS Code uses for repositories with several configurations. The CLI
does not discover those on its own, so `/devcontainer up` passes `--config` with
the path that was found.

If the matching container is running, these tools execute inside it:

| Tool | How it runs in the container |
|------|------------------------------|
| `read` | `cat` (byte-exact, so images still work) |
| `write` | content piped over stdin, never through shell quoting |
| `edit` | container-side read + write |
| `bash` | `bash -lc` in the container workspace |
| `ls` | `find -printf`, falling back to `ls -A` |
| `find` | container `find`, globs matched in-process |
| `grep` | container `rg` when present, otherwise `grep`; output formatted exactly like pi's built-in grep |

The system prompt's working directory is rewritten so the model knows it is
working inside the container.

`!` commands are routed too, since they also decide where work happens. Set
`"userBash": "host"` to keep them on the host instead, with a normal host shell:

```jsonc
// ~/.pi/agent/settings.json
{
  "devcontainer": { "userBash": "host" }
}
```

The `/devcontainer` menu shows which setting is in effect.

### The workspace folder

Everything hangs off one directory: the one holding the devcontainer
configuration that was found by walking up. If pi starts in
`/home/me/app/services/api` and the configuration lives at
`/home/me/app/.devcontainer/devcontainer.json`, then `/home/me/app` is the
workspace folder, whatever subdirectory you happened to start in.

It decides three things:

| | |
|---|---|
| Which container is yours | Containers are matched on the `devcontainer.local_folder` and `devcontainer.config_file` labels, which hold exactly this path |
| What `/devcontainer up` builds | It is passed as `--workspace-folder`, with `--config` for the configuration that was found, so the container is the one this project describes |
| How paths translate | It is the host end of the mapping described below |

The container end of the pair is read from the container itself: the bind mount
whose source is the workspace folder, whose destination is the workspace path
inside the container, normally `/workspaces/<folder name>`. It is read rather
than assumed, so a `workspaceFolder` set in `devcontainer.json` is honoured. If
no such mount is found, `/workspaces/<folder name>` is used as a fallback.

The `/devcontainer` menu shows both ends, and the session directory too when you
started somewhere below the workspace folder.

### Paths

The workspace exists under two names: `/home/me/app` on the host and, say,
`/workspaces/app` inside the container. The extension translates between them so
you and the model can use either.

**Into the container.** Anything under the host workspace is rewritten to its
container equivalent, so `read /home/me/app/src/a.ts` and `read src/a.ts` reach
the same file. Any other absolute path is passed through untouched and therefore
means the *container's* copy: `/etc/hosts` is the container's `/etc/hosts`, which
is the point of routing.

**Out to the host.** Only commands listed in `hostCommands` run on the host, and
their arguments get the reverse treatment: a path under the container workspace
becomes the host path, so `review-tool /workspaces/app/src/a.ts` opens the real
file.

That reverse direction is the one with an ambiguity worth knowing about. If your
host genuinely has a directory at the container workspace path, an argument like
`/workspaces/app/x` is valid on both sides and rewriting it would retarget a
perfectly good host path. The rule is that reality wins: if the argument already
exists on the host, it is used as given and no aliasing happens. Aliasing only
fills in a path the host does not have.

Paths outside the workspace are never rewritten in either direction, so there is
nothing to collide with there.

If you start pi in a subdirectory of the project, the devcontainer is still
found by walking up, and routed tool calls run in that subdirectory's container
equivalent, so relative paths mean what they do on the host. `/devcontainer up`
always targets the directory holding the configuration, not the directory you
happen to be in.

## Startup message

Routing active, shown as an ordinary notification:

```
✓ All tool calls are being routed into the devcontainer.
  devcontainer.json: /home/me/app/.devcontainer/devcontainer.json
  container:         nifty_hopper
  workspace:         /workspaces/app (host: /home/me/app)
```

No devcontainer found. This is a **warning**, which pi renders in its warning
style, and the wording is blunt because the consequence is:

```
⚠ No devcontainer found. All tool calls are running on the host.
  host workspace: /home/me/scratch
```

A devcontainer exists but its container is stopped (or no runtime is installed):

```
⚠ Devcontainer found, but its container is not running.
All tool calls are running on the host.
  devcontainer.json: /home/me/app/.devcontainer/devcontainer.json
  Run /devcontainer up to start it and route tool calls into it.
```

## Status bar

The footer always names the devcontainer that tool calls are routed through:

| Footer | Style | Meaning |
|--------|-------|---------|
| `⧉ devcontainer: nifty_hopper` | green | Tool calls run in that container |
| `⚠ host · devcontainer: nifty_hopper (off)` | yellow | Container available, routing toggled off |
| `⚠ host · devcontainer stopped` | yellow | Config found, container not running |
| `⚠ host · no devcontainer` | yellow | No config found |

Green means the work is contained; a yellow warning sign means it is not. The
footer is the thing to glance at, so the two states are meant to be
distinguishable without reading them.

## Menu

Run `/devcontainer` with no argument to open a details panel with a routing toggle:

```
 Devcontainer

 Tool calls    routed into container
 Config        /home/me/app/.devcontainer/devcontainer.json
 Container     nifty_hopper (7ef623d25221)
 Image         mcr.microsoft.com/devcontainers/base:jammy
 Runtime       podman · running · up 14m
 Workspace     /workspaces/app
 Host path     /home/me/app
 User          vscode
 Shell         bash · ripgrep: no (using grep)
 Routed tools  read, write, edit, bash, grep, find, ls

→ Route tool calls into container  on
   Off runs read, write, edit, bash, grep, find, ls and ! commands on the host
   Enter/Space to change · Esc to cancel
```

Toggling takes effect immediately — the next tool call runs on the host (or back
in the container) and the status bar updates. The toggle lasts for the session;
it is not written to disk. When no container is running, the toggle reads
`unavailable` and the panel points at `/devcontainer up`.

## Command and flag

```
/dc                Open the details menu with the routing toggle
/dc on             Look again and route into the container
/dc off            Run tool calls on the host for this session
/dc up             Start the devcontainer (devcontainer CLI), then route into it
/dc status         Print current routing (works in non-TUI modes)

pi --no-devcontainer   Start with routing disabled
```

`/dc` is short for `/devcontainer`; either name works, with the same arguments.
`container` and `host` are accepted as longer spellings of `on` and `off`.

In non-TUI modes (`-p`, JSON, RPC) `/devcontainer` prints the status instead of
opening the menu.

## Configuration

Optional. Without any settings the extension probes `docker` then `podman` and
uses whichever one actually has the container.

Settings live in pi's own `settings.json` under a top-level `devcontainer` key:

| Scope | File | Applies |
|-------|------|---------|
| user | `~/.pi/agent/settings.json` | always |
| project | `<project>/.pi/settings.json` | trusted projects only |

Project settings win key by key; anything they do not set keeps the user value.
JSONC (comments, trailing commas) is accepted. Unknown keys and wrongly typed
values are ignored with a warning rather than failing the session.

| Key | Type | Example | Purpose |
|-----|------|---------|---------|
| `enabled` | boolean | `false` | Stay on the host in this project |
| `runtime` | string | `"/usr/local/bin/docker"` | Container CLI name or path. Skips probing |
| `runtimeArgs` | string[] | `["--context", "desktop-linux"]` | Global flags the CLI needs *before* its subcommand, such as selecting a docker context or a remote daemon. They are inserted as `docker --context desktop-linux ps ...` |
| `execArgs` | string[] | `["--env", "TERM=xterm-256color"]` | Extra flags for the `exec` call only, so they apply to commands run in the container but not to lookups |
| `devcontainerPath` | string | `"/opt/homebrew/bin/devcontainer"` | devcontainer CLI used by `/devcontainer up` |
| `upArgs` | string[] | `["--remove-existing-container"]` | Extra flags for `devcontainer up` |
| `hostCommands` | string[] | `["tuicr", "herdr"]` | Commands that must run on the host, not in the container |
| `tools` | string[] | `["bash", "write", "edit"]` | Which built-ins to claim. Default: all seven |
| `userBash` | `"container"` \| `"host"` | `"host"` | Where `!` commands run. Default: `"container"` |
| `requireContainer` | boolean | `true` | Fail tool calls instead of falling back to the host when no container is running |

Every key at once, for reference:

```jsonc
// ~/.pi/agent/settings.json
{
  "devcontainer": {
    "enabled": true,
    "runtime": "podman",
    "runtimeArgs": ["--log-level", "error"],
    "execArgs": ["--env", "TERM=xterm-256color"],
    "devcontainerPath": "devcontainer",
    "upArgs": ["--remove-existing-container"],
    "hostCommands": ["tuicr", "herdr"],
    "tools": ["read", "write", "edit", "bash", "grep", "find", "ls"],
    "userBash": "container",
    "requireContainer": false
  }
}
```

### Falling back to the host

When there is no container to route into, tool calls run on the host. How you
find out depends on when it happens.

**No container when the session starts.** pi shows a startup warning, the footer
reads `⧉ host · no devcontainer`, and tool calls run on the host from the start.

**The container is lost mid-session.** The agent must not discover this by
quietly running the next command somewhere else, so the first routed call that
finds the container gone:

1. does not run, and reports why
2. **ends the turn**, so the agent cannot continue on the host in the same breath
3. warns, and switches the footer to `⧉ host · devcontainer stopped`

Control is back with you at that point. Restart the container with
`/devcontainer up`, or just carry on: you have been told, so continuing is your
decision and later tool calls run on the host until you say otherwise.

#### Getting back into the container

Restarting the container is not enough on its own. Tell the extension, with
either of:

| | |
|---|---|
| `/dc on` | Look again and route into the container |
| `/devcontainer up` | Start the container, then route into it |

A new session also re-detects from scratch. `/dc` is short for `/devcontainer`;
both take the same arguments, and `/dc off` is the opposite of `/dc on`.

#### `requireContainer` and losing the container

`requireContainer: true` says the host is never acceptable, so it changes both
situations: tool calls fail at startup instead of falling back, and after a loss
they keep failing rather than continuing on the host.

| | `requireContainer: false` (default) | `requireContainer: true` |
|---|---|---|
| No container at startup | Warning, tool calls run on the host | Tool calls fail, with the reason |
| The call that finds the container gone | Does not run, ends the turn, warns | Same |
| If you continue afterwards | Tool calls run on the host | Tool calls keep failing |
| `/dc on` or `/devcontainer up` | Restores routing | Restores routing |
| `/dc off` | Switches to the host deliberately | Refused, and says so |

In short: the mid-session rule makes sure the *change* is visible, and
`requireContainer` decides whether running on the host is allowed at all. To
allow it again with `requireContainer: true`, remove the setting; nothing in the
session can override it, and neither can a project.

## Compatibility with other pi extensions

pi treats two extensions registering the same tool name as a **hard error** and
refuses to load the later one. This extension claims `read`, `write`, `edit`,
`bash`, `grep`, `find` and `ls`, so it collides with any other extension that
overrides the same built-ins.

| Extension | Status |
|-----------|--------|
| MCP adapters, memory/compaction tools | Compatible: different tool names |
| Read/search enhancers that override `read`/`grep`/`edit`/`write` | Conflicts on those names |
| Display wrappers that re-register built-ins | Conflicts, and some claim whichever built-ins are still free |
| Host sandbox providers that override `bash` | Conflicts, and overlaps in purpose |

Use `tools` to claim only a subset and leave the rest to another extension:

```jsonc
// ~/.pi/agent/settings.json
{
  "devcontainer": {
    "tools": ["bash", "write", "edit", "find", "ls"]
  }
}
```

Two caveats before doing that:

- **Anything not claimed here runs on the host.** Leaving `read` and `grep` to
  another extension means the model reads host files while it executes in the
  container. The startup message and the `/devcontainer` menu list unrouted
  tools explicitly so this is never silent.
- **A host sandbox and a container are two answers to the same question.** If
  another extension already isolates execution on the host, running both is
  contradictory; pick one.

Tools from MCP servers are not routed either. They are separate tools run by
their own server process on the host, outside the container boundary.

## Requirements

**On the host**

- `docker` or `podman`. Both are probed, and the one that actually has the
  container is used.
- A **running** container for the workspace, carrying the
  `devcontainer.local_folder` / `devcontainer.config_file` labels that identify
  it. Anything that speaks the devcontainer spec sets these: VS Code, the
  devcontainer CLI, or `/devcontainer up`.
- The `devcontainer` CLI **only** if you want `/devcontainer up` to start the
  container for you.

The last two are independent, not nested. Starting containers from VS Code
satisfies the second without the CLI ever being installed; conversely, having
the CLI installed does not give you a running container. If you never use
`/devcontainer up`, you do not need the CLI at all.

**In the container**

Nothing beyond a shell and coreutils. `rg` is used for `grep` when present and
plain `grep` otherwise: at detection time the extension runs
`command -v rg` inside the container, once, and the answer is shown in the
`/devcontainer` menu as `Shell  bash · ripgrep: no (using grep)`. The same probe
picks `bash` or falls back to `sh`.

## Behavior notes

- When no devcontainer is found, or its container is not running, tool calls
  fall back to the host instead of failing, unless `requireContainer` is set. This is never silent: pi shows a
  startup warning saying tool calls are running on the host, and the footer
  shows `⧉ host · no devcontainer` or `⧉ host · devcontainer stopped` for the
  whole session. See [Status bar](#status-bar).
- Commands run in the container as the user your `devcontainer.json` asks for:
  `remoteUser`, or `containerUser` if that is the one set. If that user does not
  work in the container, the extension stops passing `--user` and lets the
  container use the image's own default user rather than failing the call.
- `.git` and `node_modules` are skipped by `find` and `grep`. Without `rg` in the
  container, `.gitignore` is not honored by `grep`.
- Aborts and timeouts kill the process inside the container.
- Detection runs in the background at session start, so pi is usable
  immediately. The startup message and the footer appear when it finishes, and
  a tool call that arrives first simply waits for the same answer.
- Container CLI probes and inspections are bounded at 15s, so an unresponsive
  daemon or a stale `DOCKER_HOST` cannot hang pi at startup. `/devcontainer up`
  is deliberately unbounded because building an image can take minutes; while it
  runs, its output is shown live above the editor, so a long build looks like
  progress rather than a hang.
- `PI_SESSION_ID`, `PI_PROVIDER`, `PI_MODEL` and `PI_REASONING_LEVEL` are
  forwarded into container commands. pi sets these for its own `bash` tool and
  tells the model it can read them, so forwarding keeps that true once commands
  are routed: a script can tag build artefacts or a commit with the session that
  produced them, log which model made a change, or take a different path for a
  cheaper model. Nothing in this extension depends on them.
- `PI_SESSION_FILE` is **not** forwarded, because it is a host path: inside the
  container it would name a file that does not exist. Host variables that merely
  begin with `PI_` are not forwarded either; apart from the four above, the
  environment is the container's own.

## Repository layout

```
package.json          pi manifest (pi.extensions -> ./src/index.ts)
src/index.ts          entry point: tool overrides, events, status bar, menu, flag
src/operations.ts     container-backed tool operations, path mapping, grep
src/container.ts      runtime detection, container lookup, exec plumbing
src/discovery.ts      devcontainer.json discovery, JSONC parsing
src/config.ts         settings.json merging
src/routing.ts        which commands escape to the host
test/test-discovery.ts   unit tests, no container or pi packages needed
test/test-config.ts      settings merging and runtime/CLI arg wiring
test/test-routing.ts     host-command matching and escape behaviour
test/test-harness.ts     container operations against a real container
test/test-escape.ts      proves routed tools cannot reach the host
test/test-extension.ts   extension lifecycle and routing (5 scenarios)
test/test-menu.ts        menu rendering, status bar, routing toggle
dev/container-status.ts  reports whether this repo's container is running
devenv.nix            dev shell, dev scripts, and `devenv test`
.devcontainer/        generated by devenv; also the fixture the tests use
```

## Development

The repo uses [devenv](https://devenv.sh) to provide Node and npm, so the
toolchain is the same everywhere and does not depend on what happens to be on
your PATH.

The sources and tests are `.ts` run directly by Node, so it needs unflagged
TypeScript type stripping (Node 23.6+) and `path.posix.matchesGlob` (Node
22.5+). `devenv.nix` pins `pkgs.nodejs_24` rather than tracking the newest
release for two reasons: 24 is the active LTS line, while `pkgs.nodejs_latest`
is currently 26.x and on the short-lived current track; and pinning means a
nixpkgs bump cannot change the runtime under the test suite without a visible
edit. Nothing here depends on 24 specifically, so bumping that one line is
enough if you want a newer Node.

```bash
devenv shell        # node, npm, and the scripts below

pi-link-deps        # link pi's peer deps into ./node_modules
pi-check            # unit tests only, no container required
pi-test             # full suite, needs this repo's devcontainer running
pi-container-up     # start the devcontainer
```

`devenv.nix` also generates `.devcontainer/devcontainer.json`, so the container
the tests run against is defined in the same place as the dev shell.

`pi-link-deps` symlinks pi's peer dependencies into `node_modules/` so the test
files can resolve them. It is gitignored, is not part of the published package,
and is recreated on every `pi-check`/`pi-test` run, so it can be deleted at any
time.

## Tests

```bash
devenv test
```

This runs the container-free checks first, then detects whether this
repository's devcontainer is running. If it is, the full suite runs against it
(197 tests). If not, the integration suites are skipped with a message rather
than failing, which is what makes the same command safe as the container's
`updateContentCommand`. Set `PI_DEVCONTAINER_SKIP_INTEGRATION=1` to force the
skip.

Without devenv, run the suites directly with Node 24:

```bash
# Same resolution pi-link-deps uses: the pi on your PATH, left unresolved so the
# link follows pi upgrades instead of pinning one version's install path.
PI=$(dirname "$(command -v pi)")/../lib/node_modules/pi-monorepo
mkdir -p node_modules/@earendil-works
ln -sfn "$PI" node_modules/@earendil-works/pi-coding-agent
ln -sfn "$PI/node_modules/@earendil-works/pi-tui" node_modules/@earendil-works/pi-tui

node test/test-discovery.ts
node test/test-config.ts
node test/test-routing.ts
node test/test-harness.ts
node test/test-extension.ts container
node test/test-extension.ts disabled
node test/test-menu.ts
(tmp=$(mktemp -d) && echo on-the-host > "$tmp/host-marker.txt" \
  && cd "$tmp" && node "$OLDPWD/test/test-extension.ts" host)
```

The suites derive the repository path, container name, and container workspace
from discovery, so they work in any checkout with a running devcontainer.
