/**
 * Devcontainer Tool Routing
 *
 * Routes pi's built-in tools (read, write, edit, bash, grep, find, ls) and
 * user `!` commands into the running devcontainer for the current project.
 *
 * The nearest `.devcontainer/devcontainer.json` is located by walking up from
 * the working directory. When its container is running, every tool call is
 * executed inside that container. When no devcontainer is found, tools keep
 * running on the host and the user is warned at startup.
 *
 * Commands:
 *   /devcontainer            Show routing status
 *   /devcontainer up         Start the devcontainer, then route into it
 *   /devcontainer host       Temporarily run tools on the host
 *   /devcontainer container  Resume routing into the container
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_DIR_NAME,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	DynamicBorder,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import {
	type ContainerTarget,
	discoverContainer,
	devcontainerUp,
	getContainerDetails,
	isContainerGoneError,
	type RuntimeSpec,
} from "./container.ts";
import {
	type ConfigSource,
	DEFAULT_CONFIG,
	type DevcontainerExtensionConfig,
	loadConfig,
	ROUTABLE_TOOLS,
} from "./config.ts";
import { type DevcontainerConfig, findDevcontainerConfig } from "./discovery.ts";
import { planHostCommand, toHostPath } from "./routing.ts";
import {
	createContainerBashOps,
	createContainerEditOps,
	createContainerFindOps,
	createContainerLsOps,
	createContainerReadOps,
	createContainerWriteOps,
	createHostArgvOperations,
	executeContainerGrep,
	toContainerPath,
} from "./operations.ts";

const STATUS_KEY = "devcontainer";


interface RoutingState {
	devcontainer: DevcontainerConfig | null;
	runtimes: RuntimeSpec[];
	config: DevcontainerExtensionConfig;
	configSources: ConfigSource[];
	target: ContainerTarget | null;
	/** User opted out of routing for this session */
	disabled: boolean;
}

export default function (pi: ExtensionAPI) {
	const localCwd = process.cwd();

	// Host tools provide metadata, renderers, and the fallback implementation.
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);
	const localGrep = createGrepTool(localCwd);
	const localFind = createFindTool(localCwd);
	const localLs = createLsTool(localCwd);

	// Which built-ins to claim must be known before registering, and pi treats a
	// duplicate tool name as a hard error that disables the other extension.
	// This is user-scope only, so it can be read before trust is resolved.
	const claimed = new Set(
		loadConfig({ configDirName: CONFIG_DIR_NAME, cwd: localCwd, trusted: false }).config.tools,
	);

	const state: RoutingState = {
		devcontainer: null,
		runtimes: [],
		config: { ...DEFAULT_CONFIG },
		configSources: [],
		target: null,
		disabled: false,
	};

	let detecting: Promise<void> | undefined;
	let detectedOnce = false;
	let projectTrusted = false;


	/** Discover the devcontainer and its running container. */
	async function detect(): Promise<void> {
		const previous = state.target;
		state.devcontainer = findDevcontainerConfig(localCwd);
		state.target = null;
		state.runtimes = [];

		const loaded = loadConfig({
			configDirName: CONFIG_DIR_NAME,
			cwd: localCwd,
			trusted: projectTrusted,
		});
		state.config = loaded.config;
		state.configSources = loaded.sources;

		if (!state.devcontainer) return;

		const { runtimes, target } = await discoverContainer(state.config, state.devcontainer, previous);
		state.runtimes = runtimes;
		state.target = target;
	}

	function runDetection(): Promise<void> {
		detecting = detect().finally(() => {
			detectedOnce = true;
			detecting = undefined;
		});
		return detecting;
	}

	/**
	 * Detection happens once per session, and after that only when the user asks
	 * through a /devcontainer command. Tool calls never probe: on rootless podman
	 * a single lookup is most of a second, which would be paid by whichever tool
	 * call happened to trigger it.
	 */
	async function ensureDetected(): Promise<void> {
		if (detecting) return detecting;
		if (!detectedOnce) return runDetection();
	}

	/** Look again right now; for explicit user actions. */
	async function refreshDetection(): Promise<void> {
		if (detecting) return detecting;
		return runDetection();
	}

	/**
	 * A tool result that hands control back to the user.
	 *
	 * Losing the container mid-turn changes where code runs, so the agent should
	 * not simply carry on: the next call would land on the host. `terminate`
	 * skips the follow-up model call once every result in the batch is
	 * terminating, which is the case here because sibling calls are routed too.
	 * Throwing instead would flag an error but leave the loop running.
	 */
	function haltingResult(text: string) {
		return { content: [{ type: "text" as const, text }], details: undefined, terminate: true };
	}

	/** Forget the container we were routing into; /devcontainer looks again. */
	function forgetContainer(): void {
		state.target = null;
	}

	/**
	 * Where a routed tool call should consider itself to be.
	 *
	 * pi's own tools resolve relative paths against the session's working
	 * directory, so the routed ones must resolve against its container
	 * equivalent. Using the workspace root instead would silently change what a
	 * relative path means whenever pi is started in a subdirectory.
	 */
	function containerCwd(target: ContainerTarget): string {
		return toContainerPath(target, localCwd);
	}

	/**
	 * Translate one argument of a host command.
	 *
	 * Container workspace paths are rewritten to their host equivalent so a
	 * model that learned the container layout still names real files. An
	 * argument that already exists on the host is left alone, so a host that
	 * genuinely has a directory at the container workspace path keeps winning
	 * over the alias.
	 */
	function hostArgument(target: ContainerTarget, argument: string): string {
		return toHostPath(argument, target.containerWorkspace, target.hostWorkspace, existsSync);
	}

	/** The container to route into, or null when tools should run on the host. */
	async function activeTarget(): Promise<ContainerTarget | null> {
		await ensureDetected();
		if (state.disabled) return null;
		return state.target;
	}

	/** Footer text naming the devcontainer that tool calls are routed through. */
	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const theme = ctx.ui.theme;
		const { target, devcontainer, disabled } = state;

		// Contained work is green; anything on the host is yellow with a warning
		// sign, so the footer can be told apart at a glance.
		if (target && !disabled) {
			ctx.ui.setStatus(STATUS_KEY, theme.fg("success", `⧉ devcontainer: ${target.name}`));
		} else if (target) {
			ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", `⚠ host · devcontainer: ${target.name} (off)`));
		} else if (devcontainer) {
			ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", "⚠ host · devcontainer stopped"));
		} else {
			ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", "⚠ host · no devcontainer"));
		}
	}

	/** Startup summary: where tool calls will actually run. */
	function describeRouting(): { message: string; level: "info" | "warning" } {
		const { devcontainer, target, runtimes, disabled } = state;

		if (target && disabled) {
			return {
				level: "warning",
				message: [
					"⚠ Devcontainer routing is disabled. All tool calls are running on the host.",
					`  devcontainer.json: ${target.configPath}`,
					`  container:         ${target.name} (available, not in use)`,
					"  Run /devcontainer container to route tool calls into it.",
				].join("\n"),
			};
		}

		if (target) {
			return {
				level: "info",
				message: [
					"✓ All tool calls are being routed into the devcontainer.",
					`  devcontainer.json: ${target.configPath}`,
					`  container:         ${target.name}`,
					`  workspace:         ${target.containerWorkspace} (host: ${target.hostWorkspace})`,
					`  routed tools:      ${[...claimed].join(", ") || "none"}`,
					...(ROUTABLE_TOOLS.some((name) => !claimed.has(name))
						? [
								`  NOT routed:        ${ROUTABLE_TOOLS.filter((name) => !claimed.has(name)).join(", ")}` +
									" (these still run on the host)",
							]
						: []),
				].join("\n"),
			};
		}

		if (!devcontainer) {
			return {
				level: "warning",
				message: [
					state.config.requireContainer
						? "No devcontainer found. requireContainer is set, so tool calls will fail rather than run on the host."
						: "⚠ No devcontainer found. All tool calls are running on the host.",
					`  host workspace: ${localCwd}`,
				].join("\n"),
			};
		}

		const reason =
			runtimes.length === 0
				? state.config.runtime
					? `the configured runtime "${state.config.runtime}" is not available`
					: "no container runtime (docker or podman) is available"
				: "its container is not running";

		return {
			level: "warning",
			message: [
				`⚠ Devcontainer found, but ${reason}.`,
				"All tool calls are running on the host.",
				`  devcontainer.json: ${devcontainer.configPath}`,
				runtimes.length > 0 ? "  Run /devcontainer up to start it, or /dc on if it is already running." : "",
			]
				.filter(Boolean)
				.join("\n"),
		};
	}

	pi.registerFlag("no-devcontainer", {
		description: "Run tool calls on the host even when a devcontainer is available",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async (_event, ctx) => {
		detectedOnce = false;
		// Default to untrusted: project-scoped config can name executables.
		projectTrusted = ctx.isProjectTrusted?.() ?? false;
		state.disabled = pi.getFlag("no-devcontainer") === true;

		// Detection costs several container CLI round trips, which are slow
		// enough to be felt. Do it in the background so pi starts immediately;
		// the first tool call waits on the same promise if it gets there first.
		void ensureDetected().then(() => {
			if (!state.config.enabled) state.disabled = true;
			updateStatus(ctx);
			if (!ctx.hasUI) return;
			const { message, level } = describeRouting();
			ctx.ui.notify(message, level);
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	// Tell the model that paths and commands resolve inside the container.
	pi.on("before_agent_start", async (event) => {
		const target = await activeTarget();
		if (!target) return;

		const hostLine = `Current working directory: ${localCwd}`;
		let containerLine = [
			`Current working directory: ${containerCwd(target)}`,
			`(inside devcontainer "${target.name}"; host path ${target.hostWorkspace} is mounted at ${target.containerWorkspace})`,
		].join(" ");

		if (state.config.hostCommands.length > 0) {
			containerLine +=
				` These exact commands run on the host instead, as a single program with plain` +
				` arguments and no shell features: ${state.config.hostCommands.join(", ")}.`;
		}

		const systemPrompt = event.systemPrompt.includes(hostLine)
			? event.systemPrompt.replace(hostLine, containerLine)
			: `${event.systemPrompt}\n\n${containerLine}`;
		return { systemPrompt };
	});

	/**
	 * Every routed tool follows the same shape: fall back to the host tool when
	 * there is no container, otherwise run the container-backed equivalent.
	 * Only bash and grep add anything of their own.
	 */
	type ToolRunner = (
		target: ContainerTarget,
		id: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: any,
		ctx: any,
	) => Promise<any>;

	const routedTools: Array<{ name: string; local: any; run: ToolRunner }> = [
		{
			name: "read",
			local: localRead,
			run: (target, id, params, signal, onUpdate) =>
				createReadTool(containerCwd(target), {
					operations: createContainerReadOps(target),
				}).execute(id, params, signal, onUpdate),
		},
		{
			name: "write",
			local: localWrite,
			run: (target, id, params, signal, onUpdate) =>
				createWriteTool(containerCwd(target), {
					operations: createContainerWriteOps(target),
				}).execute(id, params, signal, onUpdate),
		},
		{
			name: "edit",
			local: localEdit,
			run: (target, id, params, signal, onUpdate) =>
				createEditTool(containerCwd(target), {
					operations: createContainerEditOps(target),
				}).execute(id, params, signal, onUpdate),
		},
		{
			name: "ls",
			local: localLs,
			run: (target, id, params, signal, onUpdate) =>
				createLsTool(containerCwd(target), {
					operations: createContainerLsOps(target),
				}).execute(id, params, signal, onUpdate),
		},
		{
			name: "find",
			local: localFind,
			run: (target, id, params, signal, onUpdate) =>
				createFindTool(containerCwd(target), {
					operations: createContainerFindOps(target),
				}).execute(id, params, signal, onUpdate),
		},
		{
			name: "grep",
			local: localGrep,
			run: (target, _id, params, signal) =>
				executeContainerGrep(target, params, { hasRipgrep: target.hasRipgrep, cwd: containerCwd(target) }, signal),
		},
		{
			name: "bash",
			local: localBash,
			run: (target, id, params, signal, onUpdate, ctx) => {
				// Host-only tooling cannot run in the container. Anything that
				// reaches the host runs as argv, with no shell.
				const plan = planHostCommand(params.command, state.config.hostCommands);
				if (plan.mode === "blocked") {
					throw new Error(`Refused to run this on the host: ${plan.reason}.`);
				}
				const operations =
					plan.mode === "host"
						? createHostArgvOperations(plan.argv.map((entry) => hostArgument(target, entry)))
						: createContainerBashOps(target, target.shell);
				// Host commands run where pi was started; routed ones in its
				// container equivalent.
				const cwd = plan.mode === "host" ? localCwd : containerCwd(target);
				// Pass a context so pi populates its session variables, but with the
				// cwd it should resolve against rather than the host one. Only when
				// it is complete enough to use: pi reads sessionManager off it.
				const toolCtx = ctx?.sessionManager ? { ...ctx, cwd } : undefined;
				return createBashTool(cwd, { operations }).execute(id, params, signal, onUpdate, toolCtx);
			},
		},
	];

	for (const tool of routedTools) {
		if (!claimed.has(tool.name)) continue;
		pi.registerTool({
			...tool.local,
			async execute(id, params, signal, onUpdate, ctx) {
				const target = await activeTarget();
				if (!target) {
					// requireContainer is absolute: it outranks how we got here, and
					// host execution is never offered as a way out.
					if (state.config.requireContainer) {
						const { message } = describeRouting();
						ctx?.ui?.notify("requireContainer is set and there is no container to route into.", "error");
						return haltingResult(
							"This tool call did not run. requireContainer is set, so tool calls never run on the host. " +
								`Start the container with /devcontainer up.\n${message}`,
						);
					}
					// The loss was already reported and the turn stopped, so continuing
					// here is the user's decision, not a silent switch.
					return tool.local.execute(id, params, signal, onUpdate);
				}
				try {
					return await tool.run(target, id, params, signal, onUpdate, ctx);
				} catch (error) {
					if (!isContainerGoneError(error)) throw error;
					// The container disappeared mid-session. Drop it, tell the user,
					// and stop the turn rather than quietly continuing on the host.
					const name = target.name;
					forgetContainer();
					if (ctx) updateStatus(ctx);
					ctx?.ui?.notify(
						`Devcontainer "${name}" stopped. Tool calls are no longer routed into it.`,
						"warning",
					);
					const next = state.config.requireContainer
						? "Tool calls will not run until it is back, because requireContainer is set."
						: "This turn was stopped so you can decide; if you continue, further tool calls run on the host.";
					return haltingResult(
						`The devcontainer "${name}" is no longer running, so this tool call did not run. ` +
							`${next} Start it with /devcontainer up, or run /dc on once it is back.`,
					);
				}
			},
		});
	}

	// Route user `!` commands into the container as well.
	// `!` commands. These are typed by the person, not the model, but they still
	// decide where work happens, so they follow the same routing.
	pi.on("user_bash", async (event) => {
		if (state.config.userBash === "host") return;

		const target = await activeTarget();
		if (!target) {
			// Same rule as tool calls: run on the host unless requireContainer forbids it.
			if (!state.config.requireContainer) return;
			return {
				result: {
					output: "Not run. requireContainer is set and there is no container to run in.\n",
					exitCode: 1,
					cancelled: false,
					truncated: false,
				},
			};
		}

		const plan = planHostCommand(event.command, state.config.hostCommands);
		if (plan.mode === "blocked") {
			return {
				result: {
					output:
						`Not run on the host: ${plan.reason}.\n` +
						'Set "userBash": "host" if you want ! commands to use a host shell.\n',
					exitCode: 1,
					cancelled: false,
					truncated: false,
				},
			};
		}
		if (plan.mode === "host") {
			const argv = plan.argv.map((entry) => toHostPath(entry, target.containerWorkspace, target.hostWorkspace));
			return { operations: createHostArgvOperations(argv) };
		}
		return { operations: createContainerBashOps(target, target.shell) };
	});

	/** Human-readable uptime such as "up 3h 12m". */
	function formatUptime(startedAt: string | undefined): string {
		if (!startedAt) return "";
		const started = Date.parse(startedAt);
		if (!Number.isFinite(started)) return "";
		const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
		const days = Math.floor(seconds / 86400);
		const hours = Math.floor((seconds % 86400) / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		if (days > 0) return `up ${days}d ${hours}h`;
		if (hours > 0) return `up ${hours}h ${minutes}m`;
		if (minutes > 0) return `up ${minutes}m`;
		return `up ${seconds}s`;
	}

	/** Detail rows rendered at the top of the menu. */
	async function collectDetails(): Promise<Array<[string, string]>> {
		const { devcontainer, target, runtimes } = state;
		const rows: Array<[string, string]> = [];

		rows.push(["Tool calls", target && !state.disabled ? "routed into container" : "running on host"]);
		rows.push(["Config", devcontainer?.configPath ?? "none found"]);
		if (devcontainer?.config.name) rows.push(["Config name", String(devcontainer.config.name)]);

		if (!target) {
			rows.push([
				"Runtime",
				runtimes.length > 0 ? runtimes.map((r) => r.bin).join(", ") : "none (install docker or podman)",
			]);
			if (devcontainer) rows.push(["Container", "not running — use /devcontainer up"]);
			rows.push(["Host workspace", localCwd]);
			return rows;
		}

		const details = await getContainerDetails(target);
		const runtimeParts = [target.runtime.bin, details.status, formatUptime(details.startedAt)].filter(Boolean);

		rows.push(["Container", `${target.name} (${details.shortId})`]);
		if (details.image) rows.push(["Image", details.image]);
		rows.push(["Runtime", runtimeParts.join(" · ")]);
		rows.push(["Workspace", target.containerWorkspace]);
		if (containerCwd(target) !== target.containerWorkspace) {
			rows.push(["Session directory", containerCwd(target)]);
		}
		rows.push(["Host path", target.hostWorkspace]);
		rows.push(["User", target.user ?? "container default"]);
		rows.push(["Shell", `${target.shell} · ripgrep: ${target.hasRipgrep ? "yes" : "no (using grep)"}`]);
		rows.push(["Routed tools", [...claimed].join(", ") || "none"]);
		rows.push(["! commands", state.config.userBash === "host" ? "host" : "container"]);
		const unrouted = ROUTABLE_TOOLS.filter((name) => !claimed.has(name));
		if (unrouted.length > 0) rows.push(["On the host", unrouted.join(", ")]);
		appendConfigRows(rows);
		return rows;
	}

	/** Show which config sources are active and what they changed. */
	function appendConfigRows(rows: Array<[string, string]>): void {
		if (state.configSources.length === 0) {
			rows.push(["Config overrides", "none (defaults)"]);
			return;
		}
		for (const source of state.configSources) {
			const keys = source.applied.length > 0 ? source.applied.join(", ") : "no recognised keys";
			rows.push([`Config: ${source.label}`, keys]);
		}
		if (state.config.runtimeArgs.length > 0) rows.push(["runtimeArgs", state.config.runtimeArgs.join(" ")]);
		if (state.config.execArgs.length > 0) rows.push(["execArgs", state.config.execArgs.join(" ")]);
		if (state.config.upArgs.length > 0) rows.push(["upArgs", state.config.upArgs.join(" ")]);
		if (state.config.hostCommands.length > 0) {
			rows.push(["Host commands", state.config.hostCommands.join(", ")]);
		}
	}

	/** Interactive details panel with a routing toggle. */
	async function openMenu(ctx: ExtensionCommandContext): Promise<void> {
		// An explicit action: always look again, so a container that came back is
		// picked up here too.
		await refreshDetection();
		updateStatus(ctx);

		if (ctx.mode !== "tui") {
			const { message, level } = describeRouting();
			ctx.ui.notify(message, level);
			return;
		}

		const rows = await collectDetails();
		const hasTarget = state.target !== null;

		await ctx.ui.custom((tui, theme, _keybindings, done) => {
			const labelWidth = Math.max(...rows.map(([label]) => label.length));

			// One row per line: truncate long values instead of letting them wrap.
			const detailRows = {
				render(width: number): string[] {
					return rows.map(([label, value]) => {
						const prefix = ` ${label.padEnd(labelWidth)}  `;
						const available = Math.max(8, width - prefix.length - 1);
						const shown = value.length > available ? `${value.slice(0, available - 1)}…` : value;
						return `${theme.fg("muted", prefix)}${shown}`;
					});
				},
				invalidate() {},
			};

			const container = new Container();

			container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Devcontainer")), 1, 0));
			container.addChild(new Text("", 1, 0));
			container.addChild(detailRows);
			container.addChild(new Text("", 1, 0));

			const items: SettingItem[] = [
				hasTarget
					? {
							id: "routing",
							label: "Route tool calls into container",
							description: "Off runs read, write, edit, bash, grep, find, ls and ! commands on the host",
							currentValue: state.disabled ? "off" : "on",
							values: ["on", "off"],
						}
					: {
							id: "routing",
							label: "Route tool calls into container",
							description: "Unavailable: no running container for this workspace",
							currentValue: "unavailable",
						},
			];

			const settingsList = new SettingsList(
				items,
				items.length + 2,
				getSettingsListTheme(),
				(id, newValue) => {
					if (id !== "routing" || !hasTarget) return;
					state.disabled = newValue === "off";
					rows[0][1] = state.disabled ? "running on host" : "routed into container";
					updateStatus(ctx);
					tui.requestRender();
				},
				() => done(undefined),
			);
			container.addChild(settingsList);

			// SettingsList renders its own key hint; only add guidance it cannot give.
			if (!hasTarget) {
				container.addChild(
					new Text(theme.fg("dim", "Run /devcontainer up to start the container"), 1, 0),
				);
			}
			container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));

			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					settingsList.handleInput?.(data);
					tui.requestRender();
				},
			};
		});

		updateStatus(ctx);
	}
	const devcontainerCommand = {
		description: "Devcontainer details and tool routing",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "on", label: "on", description: "Look again and route into the container" },
				{ value: "off", label: "off", description: "Run tool calls on the host" },
				{ value: "status", label: "status", description: "Print current routing" },
				{ value: "up", label: "up", description: "Start the devcontainer and route into it" },
				{ value: "host", label: "host", description: "Run tool calls on the host" },
				{ value: "container", label: "container", description: "Resume routing into the container" },
			].filter((item) => item.value.startsWith(prefix));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();

			if (action === "off" || action === "host") {
				if (state.config.requireContainer) {
					ctx.ui.notify(
						"requireContainer is set, so tool calls will not run on the host. " +
							"Remove it from your settings first, or start the container with /devcontainer up.",
						"error",
					);
					return;
				}
				state.disabled = true;
				updateStatus(ctx);
				const { message, level } = describeRouting();
				ctx.ui.notify(message, level);
				return;
			}

			if (action === "on" || action === "container") {
				state.disabled = false;
				await refreshDetection();
				updateStatus(ctx);
				const { message, level } = describeRouting();
				ctx.ui.notify(message, level);
				return;
			}

			if (action === "up") {
				await ensureDetected();
				if (!state.devcontainer) {
					ctx.ui.notify("No devcontainer.json found from this directory upward.", "error");
					return;
				}
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "⧗ devcontainer: starting"));
				ctx.ui.notify(`Starting devcontainer for ${state.devcontainer.workspaceFolder}...`, "info");

				// Starting a container can take minutes, so show what it is doing
				// rather than leaving the user with a frozen command.
				const recent: string[] = [];
				const onOutput = (chunk: string) => {
					for (const line of chunk.split("\n")) {
						const text = line.trim();
						if (!text) continue;
						recent.push(text);
						if (recent.length > 6) recent.shift();
					}
					ctx.ui.setWidget?.(
						STATUS_KEY,
						[ctx.ui.theme.fg("muted", "devcontainer up"), ...recent.map((line) => `  ${line}`)],
					);
				};

				const result = await devcontainerUp(
					state.devcontainer.workspaceFolder,
					state.config,
					ctx.signal,
					state.devcontainer.configPath,
					onOutput,
				);
				ctx.ui.setWidget?.(STATUS_KEY, undefined);
				state.disabled = false;
				await refreshDetection();
				updateStatus(ctx);
				if (!result.ok && !state.target) {
					ctx.ui.notify(`devcontainer up failed:\n${result.output.slice(-2000)}`, "error");
					return;
				}
				const { message, level } = describeRouting();
				ctx.ui.notify(message, level);
				return;
			}

			// Print-only status for scripts and non-TUI modes.
			if (action === "status") {
				await refreshDetection();
				updateStatus(ctx);
				const { message, level } = describeRouting();
				ctx.ui.notify(message, level);
				return;
			}

			// No argument: open the details menu with the routing toggle.
			await openMenu(ctx);
		},
	};

	// `/dc` is the one people type; `/devcontainer` is the discoverable name.
	pi.registerCommand("devcontainer", devcontainerCommand);
	pi.registerCommand("dc", {
		...devcontainerCommand,
		description: "Short for /devcontainer",
	});

	// Expose discovery details for other extensions.
	pi.events.emit("devcontainer:loaded", { cwd: localCwd, basename: path.basename(localCwd) });
}
