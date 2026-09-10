# pi-devcontainer

An extension for [pi](https://pi.dev). It sends the tool calls of pi into the
[devcontainer](https://containers.dev/) of your project. The tool calls do not
run on the host.

pi reads, writes and executes in the container that your project describes. The
model sees the tools, the runtimes and the file system of that container. It
does not see the host.

```
✓ All tool calls are being routed into the devcontainer.
  devcontainer.json: /home/me/app/.devcontainer/devcontainer.json
  container:         nifty_hopper
  workspace:         /workspaces/app (host: /home/me/app)
  routed tools:      read, write, edit, bash, grep, find, ls
  host reads:        pi skills, extensions and docs (read-only)
```

The status bar shows where the tool calls run for the full session:

| Status bar | Color | Condition |
|------------|-------|-----------|
| `⧉ devcontainer: nifty_hopper` | green | The tool calls run in that container |
| `⚠ host · devcontainer: nifty_hopper (off)` | yellow | A container is available, but the routing is off |
| `⚠ host · devcontainer stopped` | yellow | There is a configuration, but no container in operation |
| `⚠ host · no devcontainer` | yellow | There is no configuration |

Green shows that the work is in a container. Yellow with a warning symbol shows
that the work is on the host.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Commands](#commands)
- [The menu](#the-menu)
- [Which tools run in the container](#which-tools-run-in-the-container)
- [Which devcontainer the extension uses](#which-devcontainer-the-extension-uses)
- [The workspace folder](#the-workspace-folder)
- [Paths](#paths)
- [Host paths](#host-paths)
- [Host commands](#host-commands)
- [Settings](#settings)
- [Operation with no container](#operation-with-no-container)
- [Operation with other extensions](#operation-with-other-extensions)
- [Other conditions](#other-conditions)
- [Disclaimer](#disclaimer)

## Requirements

**On the host**

- `docker` or `podman`. The extension examines both, and uses the runtime that
  has the container.
- A container for the workspace that is in operation. The container must have
  the `devcontainer.local_folder` and `devcontainer.config_file` labels. The
  devcontainer tools write these labels when they start a container. VS Code,
  the devcontainer CLI and `/devcontainer up` all write them.
- The `devcontainer` CLI, but only for the `/devcontainer up` command.

The last two items are independent. A container that VS Code starts agrees with
the second item, and the CLI is not necessary. If you do not use
`/devcontainer up`, you do not need the CLI.

**In the container**

A shell and the core commands. The extension uses `rg` for `grep` if the
container has it, or `grep` if it does not. At detection, the extension executes
`command -v rg` in the container one time. The same operation selects `bash` or
`sh`.

## Install

```bash
pi install git:github.com/Icohedron/pi-devcontainer          # all projects
pi install -l git:github.com/Icohedron/pi-devcontainer       # this project only
pi install git:github.com/Icohedron/pi-devcontainer@v0.3.0   # one tag
```

To use the extension for one session only:

```bash
pi -e git:github.com/Icohedron/pi-devcontainer
```

To use a local copy:

```bash
pi install -l /path/to/pi-devcontainer   # add to the settings of the project
pi -e /path/to/pi-devcontainer           # one session only
```

To remove the extension, use `pi remove git:github.com/Icohedron/pi-devcontainer`.
Add `-l` for the settings of the project.

## Commands

```
/dc                Open the menu with the details and the control
/dc on             Look again, and route the tool calls into the container
/dc off            Run the tool calls on the host for this session
/dc up             Start the devcontainer with the devcontainer CLI, then route into it
/dc status         Show the routing. This command also operates with no user interface

pi --no-devcontainer   Start with the routing off
```

`/dc` is the short name for `/devcontainer`. The two names take the same
arguments. `container` and `host` are other spellings of `on` and `off`.

In the `-p`, JSON and RPC modes, `/devcontainer` shows the status. It does not
open the menu.

A lookup asks the container runtime for the containers and their details. This
operation is not instant. It happens at the start of a session, and again for
each command in the list above that examines the container. While the extension
waits, it shows a line with the indicator that pi uses for its own work:

```
⠹ Looking for the devcontainer
```

The line comes after a short delay. A lookup that is quicker than the delay
shows no line.

## The menu

`/devcontainer` with no argument opens a panel. The panel shows the details of
the container and a control for the routing:

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
 ! commands    container
 Host reads    pi skills, extensions and docs (read-only)

→ Route tool calls into container  on
   Off runs read, write, edit, bash, grep, find, ls and ! commands on the host
   Enter/Space to change · Esc to cancel
```

The panel also shows the session directory, the roots of the host paths and the
settings that you changed, when they apply.

A change of the control starts immediately. The next tool call runs in the new
location, and the status bar changes. The change stays for the session only.
The extension does not write it to a file. If there is no container in
operation, the control shows `unavailable`, and the panel shows the
`/devcontainer up` command.

## Which tools run in the container

| Tool | Operation in the container |
|------|----------------------------|
| `read` | `cat`. The bytes do not change, and images stay correct |
| `write` | The extension sends the content on stdin. It does not use shell quotes |
| `edit` | The extension reads the file in the container, then writes it |
| `bash` | `bash -lc` in the directory of the session |
| `ls` | `find -printf`. If that command fails, `ls -A` |
| `find` | `find` in the container. The extension matches the globs in its own process |
| `grep` | `rg` if the container has it, or `grep`. The output format is the same as the built-in `grep` of pi |

pi tells the model its working directory in the system prompt. The system
prompt is the text that pi sends to the model before your first message. The
extension replaces the host directory in that text with the directory in the
container. The model then knows where its tool calls run.

`!` commands also go into the container. They run in the same directory as the
routed tool calls. Refer to [The session directory](#the-session-directory).

To run `!` commands on the host, set `"userBash": "host"`:

```jsonc
// ~/.pi/agent/settings.json
{
  "devcontainer": { "userBash": "host" }
}
```

The `! commands` line of the [menu](#the-menu) shows the location that this
setting selects.

## Which devcontainer the extension uses

At start, the extension looks for a devcontainer configuration. It starts in the
working directory and moves up through the parent directories. In each
directory, it uses the first configuration that it finds:

1. `<dir>/.devcontainer/devcontainer.json`
2. `<dir>/.devcontainer.json`
3. `<dir>/.devcontainer/<folder>/devcontainer.json`

The third location is the layout of VS Code for a project with more than one
configuration. If there is more than one `<folder>`, the extension puts the
names in alphabetical order and uses the first `<folder>` that contains a
`devcontainer.json` file. To use a different configuration, start the container
yourself, or move that configuration to `.devcontainer/devcontainer.json`.

The devcontainer CLI finds the first two locations without help. It does not
look in the subdirectories of `.devcontainer`. Thus `/devcontainer up` gives the
CLI a `--config` option with the path of the configuration that the extension
found. The CLI then builds the container for that configuration, and not for a
different one.

## The workspace folder

The workspace folder is the directory that holds `.devcontainer`. It is not the
`.devcontainer` directory. If the configuration is
`/home/me/app/.devcontainer/devcontainer.json`, the workspace folder is
`/home/me/app`. It stays `/home/me/app` if you start pi in
`/home/me/app/services/api`.

The workspace folder controls three things:

| | |
|---|---|
| Which container the extension uses | The devcontainer tools write the workspace folder into the `devcontainer.local_folder` label of the container, and the path of the configuration into the `devcontainer.config_file` label. The extension examines the labels of each container that is in operation |
| What `/devcontainer up` builds | The extension gives the workspace folder as `--workspace-folder`, and the configuration that it found as `--config` |
| Where routed calls run | The same directory in the container is the working directory for routed tool calls |

The extension also gets the path of the workspace in the container from these
labels and mounts. It looks for the bind mount whose source is the workspace
folder. The destination of that mount is the workspace path in the container,
usually `/workspaces/<folder name>`.

The extension reads this path from the container. It does not calculate the
path. A `workspaceFolder` value in `devcontainer.json` stays correct.

Some devcontainers have no bind mount from the workspace folder. A devcontainer
that clones the project into a volume is one example. The extension then uses
`/workspaces/<folder name>`, and the files in the container are a different copy
of the project. Refer to [Paths](#paths).

## Paths

A path in a tool call is a path in the container. This rule applies to a path
from the model, and to a path that you write in a message. The extension uses an
absolute path without a change. `/etc/hosts` is the `/etc/hosts` file of the
container. A relative path starts at the directory of the session in the
container. `read src/a.ts` finds the same file as on the host.

The extension does not translate a host path into a container path. The two
paths are the same file only if a bind mount connects them. A devcontainer that
clones the project into a volume has a different copy of each file.

If a tool call has a host path, the extension refuses the call. The message
gives the container path:

```
/home/me/app/src/a.ts is a host path, and paths are container paths here.
Use /workspaces/app/src/a.ts instead, or a path relative to /workspaces/app.
```

The [host paths](#host-paths) that the model can read are the one exception.
Those paths are not in the container.

### One path on the host and in the container

To use one path on both sides, mount the workspace at the same location as on
the host:

```jsonc
// .devcontainer/devcontainer.json
{
  "workspaceMount": "source=${localWorkspaceFolder},target=${localWorkspaceFolder},type=bind",
  "workspaceFolder": "${localWorkspaceFolder}"
}
```

`/home/me/app/src/a.ts` is then correct in both places, because it is one path.
The startup message, the status bar and the `/devcontainer` menu show both
paths.

### The session directory

If pi starts in a subdirectory of the project, the extension finds the
devcontainer in a parent directory. Routed tool calls and `!` commands then run
in the same subdirectory in the container:

| | |
|---|---|
| Project on the host | `/home/me/app` |
| Mount in the container | `/workspaces/app` |
| Start directory of pi | `/home/me/app/services/api` |
| Directory of routed calls | `/workspaces/app/services/api` |

`!ls` lists the directory that you started pi in. This directory is the only
host path that the extension maps to a container path.

The extension examines this directory one time, when it finds the container. If
the container does not have the directory, routed calls run in the workspace
folder. The startup message shows this condition:

```
  session dir:       /workspaces/app/services/api is not in the container; running in /workspaces/app instead
```

`/devcontainer up` always uses the directory that contains the configuration. It
does not use the directory that you started pi in.

## Host paths

pi keeps its skills and extensions on the host. The system prompt gives the
location of each skill as a host path:

```
<location>/home/me/.pi/agent/skills/tuicr/SKILL.md</location>
```

These paths are not in the container. The extension makes these host paths
available:

| Host path | Content |
|-----------|---------|
| `<agent dir>/skills` | The skills that you installed |
| `<agent dir>/extensions` | The extensions that you installed |
| `<agent dir>/npm`, `<agent dir>/git` | The packages that `pi install` writes |
| `<agent dir>/prompts`, `<agent dir>/themes`, `<agent dir>/tools` | The other resources of pi |
| `~/.agents/skills` | The skills that you share with other agents |
| The directory of each skill that pi loaded | Skills in other locations, from the `skills` setting, a package, or `--skill` |
| The `skills` and `extensions` paths in your `settings.json` | Resources in other locations |
| The documentation and examples of pi | The files that the system prompt gives a path to |
| The paths in `readableHostPaths` | Refer to [More host paths](#more-host-paths) |

`<agent dir>` is `~/.pi/agent` in a usual installation. The
`PI_CODING_AGENT_DIR` environment variable changes it. The extension gets the
location from pi. It also gets the directory of each skill from pi. It finds a
skill in a location that is not in this table.

These tools read the host paths:

| | |
|---|---|
| Tools that read host paths | `read`, `ls`, `find`, `grep` |
| Tools that do not | `write`, `edit`, `bash`, `!` commands, `hostCommands` arguments |

Access is read-only. `write`, `edit` and `bash` have no connection to the host
file system. If `write` or `edit` gets one of these paths, the extension refuses
the call.

The extension always makes the resources of pi available. If the model must not
read the skills, do not load them. Use the `--no-skills` option of pi.

The source files of your extensions and skills become available to the model. Do
not put keys in those files. Put the keys in environment variables.

### More host paths

`readableHostPaths` makes more host paths available, with the same read-only
rules:

```jsonc
// ~/.pi/agent/settings.json
{
  "devcontainer": {
    "readableHostPaths": ["~/reference", "/opt/design-docs"]
  }
}
```

An entry can start with `~`, and can be a file or a directory. A relative entry
starts at the directory that you started pi in. The extension ignores an entry
that is in the workspace, because the container has those files.

### Paths that stay unavailable

The extension has one rule of its own, the **agent directory rule**. The agent
directory of pi is available only in `skills`, `extensions`, `npm`, `git`,
`prompts`, `themes` and `tools`. The other files in that directory stay
unavailable at all roots, with all settings, and through a symbolic link. These
files include `auth.json`, `settings.json`, `models-store.json` and `sessions/`.

The extension does not deny other files by name. It has no list of the usual
names of credentials. Such a list denies usual files, and it does not find all
credentials. Make each root as small as possible, or write the rules that you
need.

### Exclusions

`unreadableHostPatterns` holds gitignore patterns for the paths that must stay
unavailable. `!` puts a path back. The last pattern that agrees with a path
controls the result.

| Pattern | The extension denies a path if | Example |
|---------|--------------------------------|---------|
| a name with no slash | one component of the path is that name | `id_rsa`, `*.pem` |
| a name with `/` at the end | one component is that directory. The files in it are also unavailable | `secrets/` |
| a pattern with a slash in it | the absolute path ends with the pattern, or is in a directory that ends with it | `extensions/pi-foo/config.json` |
| a pattern with `/` or `~/` at the start | the absolute path is the pattern, or is in it | `~/work/keys` |

These wildcards are available in one component:

| Wildcard | Function |
|----------|----------|
| `*` | 0 or more characters, but not `/` |
| `?` | 1 character, but not `/` |
| `[abc]` | 1 character from the set. `[!abc]` is 1 character that is not in the set |
| `**` | 0 or more directories, in a pattern that has a slash in it |

The extension compares full components. `id_rsa` denies a file with the name
`id_rsa`. It does not deny `id_rsa.pub` or `old_id_rsa_backup`. A pattern with a
slash agrees with the end of the path at a `/`. It does not agree in the middle
of a name. For example, the extension denies
`/home/me/.pi/agent/extensions/pi-foo/config.json` for `config.json`, `*.json`,
`pi-foo/`, `extensions/pi-foo/config.json` or `~/.pi/agent/extensions`. It does
not deny that file for `agent/config.json`.

The extension resolves each path before it applies the patterns. A path has no
`.` or `..` component at that time. A pattern can start with `./`, and
`./secrets` is the same pattern as `secrets`.

There are two differences from git. The comparison ignores letter case. A rule
for `id_rsa` also denies `ID_RSA`. A `*` also agrees with a name that starts
with a dot. `*.env` denies `.env`.

The extension also compares the destination of a symbolic link.

```jsonc
// ~/.pi/agent/settings.json
{
  "devcontainer": {
    "readableHostPaths": ["~"],
    "unreadableHostPatterns": [
      ".ssh/", ".gnupg/", ".aws/", ".kube/", ".docker/",
      ".netrc", ".npmrc", ".git-credentials",
      "*.env", ".env.*",
      "*.pem", "*.key", "*.p12",
      "secrets/",
      "!certs/public.pem"
    ]
  }
}
```

The extension ignores an entry that starts with `#`. You can copy a block of
lines from a `.gitignore` file.

The patterns apply to all available paths, and include the resource directories
of pi. An extension that keeps a configuration file with its own files is one
example:

```jsonc
"unreadableHostPatterns": ["extensions/*/config.json", "npm/**/credentials.json"]
```

An extension that keeps its data directly in `~/.pi/agent/` needs no pattern.
The agent directory rule above already denies all files in that directory that
are not resource directories.

The `/devcontainer` menu shows the roots that the extension uses.

### The workspace

The patterns apply only to host paths. A workspace path is a container path, and
the extension routes it. The container reads the file from the same bind mount.
The `.env` file of your project is available, as before. The `bash` tool also
reads it.

The extension does not follow a symbolic link from the workspace to a host path.
The container gets the path, and the container resolves the link with its own
file system. A symbolic link in the workspace cannot make a host file
available.

A project cannot set `readableHostPaths` or `unreadableHostPatterns` in its
`.pi/settings.json` file. The extension ignores these keys and gives a warning.
Refer to [Settings](#settings).

## Host commands

Only the commands in `hostCommands` run on the host:

```jsonc
// ~/.pi/agent/settings.json
{
  "devcontainer": { "hostCommands": ["tuicr", "herdr"] }
}
```

The extension sends the arguments to the host program as the model writes them.
It does not change the paths. To use one path on both sides, mount the workspace
at the same location. Refer to
[One path on the host and in the container](#one-path-on-the-host-and-in-the-container).

The extension executes the command directly. There is no shell. It runs a
command on the host only if the command has this form:

- The first word is the same as an entry in `hostCommands`. The same file name
  is not enough. `/tmp/evil/herdr` is not the same as `herdr`.
- There is no `VAR=value` before the name of the program.
- Outside of quotes, there is no `;` `&` `|` `<` `>` `$` `` ` `` `\` `(` `)`
  `{` `}` and no new line.
- Inside of double quotes, there is no `$`, `` ` `` or `\`. The other characters
  are permitted. `herdr "a;b"` gives the program one argument, `a;b`.
- Inside of single quotes, all characters are permitted. `herdr '$HOME'` gives
  the program the 5 characters `$HOME`.
- Each quote has a second quote that closes it.

If the first word is not in `hostCommands`, the command runs in the container.
If the first word is in `hostCommands`, but the command does not have the form
above, the extension refuses the command and gives the reason. It does not run
the command in the container.

## Settings

The settings are optional. If there are no settings, the extension examines
`docker`, then `podman`. It uses the runtime that has the container.

The settings are in the `devcontainer` key of the settings files of pi:

| Scope | File | Permitted keys |
|-------|------|----------------|
| user | `~/.pi/agent/settings.json` | all keys |
| project | `<project>/.pi/settings.json` | `enabled` only, and only in a project that you trust |

Most keys control which program runs on the host, or which files the model can
read. The model can write the files of a project. A project can set
`enabled` only. If a project sets a different key, the extension ignores that
key and gives a warning with its name. The `enabled` value of a project replaces
the value of the user.

The files are JSONC. Comments and a comma at the end of a list are permitted.
The extension ignores an unknown key or an incorrect value, and gives a warning.

| Key | Type | Example | Function |
|-----|------|---------|----------|
| `enabled` | boolean | `false` | Default `true`. Set `false` to run the tool calls on the host. The only key that a project can set |
| `runtime` | string | `"/usr/local/bin/docker"` | Default: examine `docker`, then `podman`. A value stops the examination |
| `runtimeArgs` | string[] | `["--context", "desktop-linux"]` | Default none. Options for the runtime before the subcommand, as in `docker --context desktop-linux ps` |
| `execArgs` | string[] | `["--env", "TERM=xterm-256color"]` | Default none. More options for the `exec` command only |
| `devcontainerPath` | string | `"/opt/homebrew/bin/devcontainer"` | Default `devcontainer`. The CLI that `/devcontainer up` uses |
| `upArgs` | string[] | `["--remove-existing-container"]` | Default none. More options for `devcontainer up` |
| `hostCommands` | string[] | `["tuicr", "herdr"]` | Default none. The commands that run on the host |
| `readableHostPaths` | string[] | `["~/reference"]` | Default none. More host paths that the model can read. The skills, extensions and documentation of pi are always available |
| `unreadableHostPatterns` | string[] | `["*.pem", "!public.pem"]` | Default none. gitignore patterns for the host paths that stay unavailable. The credentials of pi stay unavailable in all conditions |
| `tools` | string[] | `["bash", "write", "edit"]` | Default all seven. The built-in tools that the extension controls |
| `userBash` | `"container"` \| `"host"` | `"host"` | Default `"container"`. Where `!` commands run |
| `requireContainer` | boolean | `true` | Default `false`. Set `true` to make the tool calls fail if there is no container |

All keys together:

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
    "readableHostPaths": ["~/reference", "/opt/design-docs"],
    "unreadableHostPatterns": [".ssh/", "*.pem", "!public.pem"],
    "tools": ["read", "write", "edit", "bash", "grep", "find", "ls"],
    "userBash": "container",
    "requireContainer": false
  }
}
```

## Operation with no container

If there is no container, the tool calls run on the host. `requireContainer`
changes this behavior.

**At the start of the session.** pi shows a warning, and the status bar shows
the condition for the full session:

```
⚠ No devcontainer found. All tool calls are running on the host.
  host workspace: /home/me/scratch
```

If there is a devcontainer, but no container in operation, pi shows this
warning. It shows the same warning if there is no container runtime:

```
⚠ Devcontainer found, but its container is not running.
All tool calls are running on the host.
  devcontainer.json: /home/me/app/.devcontainer/devcontainer.json
  Run /devcontainer up to start it and route tool calls into it.
```

**During the session.** The first routed tool call that finds no container does
these three things:

1. It does not run the tool call, and it gives the reason.
2. It stops the turn. The model cannot continue on the host in the same turn.
3. It gives a warning. The status bar changes to `⚠ host · devcontainer stopped`.

You then have control. Start the container with `/devcontainer up`, or continue.
If you continue, the next tool calls run on the host.

To route the tool calls into the container again, use one of these commands:

| | |
|---|---|
| `/dc on` | Look again, and route into the container |
| `/devcontainer up` | Start the container, then route into it |

A new session also examines the conditions again.

### requireContainer

`requireContainer: true` does not permit the host in any condition:

| | `requireContainer: false` (default) | `requireContainer: true` |
|---|---|---|
| No container at the start | Warning, and the tool calls run on the host | The tool calls fail, with the reason |
| The tool call that finds no container | Does not run, stops the turn, gives a warning | The same |
| The tool calls after that | Run on the host | Continue to fail |
| `/dc on` or `/devcontainer up` | The routing starts again | The routing starts again |
| `/dc off` | Moves the tool calls to the host | Refused, with a message |

To permit the host again, remove the setting. A session cannot change it, and a
project cannot change it.

## Operation with other extensions

If two extensions register the same tool name, pi gives an error and does not
load the second extension. This extension registers `read`, `write`, `edit`,
`bash`, `grep`, `find` and `ls`.

| Extension | Condition |
|-----------|-----------|
| MCP adapters, memory and compaction tools | Compatible. The tool names are different |
| Extensions that replace `read`, `grep`, `edit` or `write` | Conflict on those names |
| Extensions that show the built-in tools in a different format | Conflict. Some of them take the tools that are still free |
| Sandbox extensions that replace `bash` | Conflict, and the same function |

Use `tools` to register some of the tools only:

```jsonc
// ~/.pi/agent/settings.json
{
  "devcontainer": {
    "tools": ["bash", "write", "edit", "find", "ls"]
  }
}
```

Two conditions apply. First, the tools that this extension does not register run
on the host. If another extension has `read` and `grep`, the model reads host
files while it executes commands in the container. The startup message and the
`/devcontainer` menu give the names of these tools. Second, a host sandbox and a
container do the same task. Use one of them, and not both.

The extension does not route the tools of MCP servers. Those servers run on the
host, outside the container.

## Other conditions

- Commands run as the user in your `devcontainer.json` file: `remoteUser`, or
  `containerUser`. If that user does not operate correctly, the extension stops
  the use of `--user`. The container then uses the default user of the image.
- `find` and `grep` do not examine `.git` and `node_modules`. If the container
  has no `rg`, `grep` does not use the `.gitignore` file.
- The extension uses the tools of pi to read a host path. Those tools operate as
  in a session with no container, and use the `.gitignore` file.

## Disclaimer

An AI model wrote most of the code, the tests and this documentation. The author
has reviewed each change at a high level and tested the extension. The
review was not a full audit. The automated test suite operates against a real
container, and not only against test doubles.

The model makes the tool calls, and this extension sends them into the
container. The model can execute commands in the container. It can write files
and delete files there. It can also read a small set of paths on your host. If
the container has access to a network, the model can send data to a remote
system.

A configuration that is not correct, or a defect, can cause a loss of data. It
can also make private data available to the model, and then to a remote system.
The extension keeps the credentials of pi unavailable. It cannot control what
the model does with the data that it reads. Examine the code, and make your own
decision.

The author cannot make sure that the extension is safe in all conditions. The
software has no warranty. The author has no liability for damages of any type.
The [MIT License](LICENSE) gives the full text:

> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
