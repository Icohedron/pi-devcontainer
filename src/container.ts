/**
 * Container runtime discovery and exec plumbing.
 *
 * Locates the running container belonging to a devcontainer workspace and
 * provides a single exec primitive used by all routed tool operations.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import type { DevcontainerExtensionConfig } from "./config.ts";
import type { DevcontainerConfig } from "./discovery.ts";

/** A container CLI plus the args configuration wants applied to every call. */
export interface RuntimeSpec {
	/** Binary name or absolute path, e.g. "podman" or "/usr/local/bin/docker" */
	bin: string;
	/** Global args placed before the subcommand */
	args: string[];
	/** Extra args applied to `exec` only */
	execArgs: string[];
}

const DEFAULT_RUNTIME_BINS = ["docker", "podman"];

/**
 * Probes and inspections are bounded: an unresponsive container CLI (a stale
 * DOCKER_HOST, a daemon that is not running) would otherwise hang detection,
 * and detection is awaited during session start.
 */
const HOST_PROBE_TIMEOUT_MS = 15_000;

/**
 * How long to keep reading after a process has exited.
 *
 * Node's "close" event waits for stdio to reach EOF, which never happens if a
 * grandchild inherited the pipes and outlived its parent. Container tooling
 * leaves such processes behind routinely, so waiting for "close" alone can hang
 * forever after the command has plainly finished. Settle on "exit" instead,
 * after a short window to collect whatever is still buffered.
 */
const OUTPUT_DRAIN_MS = 250;

export interface ContainerTarget {
	runtime: RuntimeSpec;
	/** Shell to run commands with: bash when present, otherwise sh */
	shell: string;
	/** Whether ripgrep is available for grep */
	hasRipgrep: boolean;
	/** Full container id */
	id: string;
	/** Human readable container name */
	name: string;
	/** Host directory bound into the container */
	hostWorkspace: string;
	/** Path of the workspace inside the container */
	containerWorkspace: string;
	/** User to exec as, when one is configured */
	user?: string;
	/** Path of the devcontainer.json that describes this container */
	configPath: string;
}

export interface ExecOptions {
	cwd?: string;
	input?: Buffer | string;
	signal?: AbortSignal;
	/** Timeout in seconds */
	timeout?: number;
	/** Stream stdout and stderr instead of buffering stdout */
	onData?: (chunk: Buffer) => void;
	/** Stop early; return the output collected so far */
	shouldStop?: () => boolean;
	/** Buffer stderr separately instead of routing it to onData */
	separateStderr?: boolean;
}

export interface ExecResult {
	stdout: Buffer;
	stderr: string;
	exitCode: number | null;
}

/** Run a host command and buffer its output. */
function runHost(
	command: string,
	args: string[],
	options: { signal?: AbortSignal; timeoutMs?: number; onOutput?: (chunk: string) => void } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return new Promise((resolve, reject) => {
		// detached so a timeout can kill the whole process group. Killing only the
		// direct child would leave grandchildren holding the pipes open, and the
		// close event would never arrive.
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
		const limit = options.timeoutMs ?? HOST_PROBE_TIMEOUT_MS;

		let stdout = "";
		let stderr = "";
		let settled = false;

		const kill = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};

		let drain: NodeJS.Timeout | undefined;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (drain) clearTimeout(drain);
			options.signal?.removeEventListener("abort", onAbort);
			fn();
		};

		// Resolve as soon as the deadline passes rather than waiting for streams a
		// wedged process may never close.
		const timer =
			limit > 0
				? setTimeout(() => {
						kill();
						finish(() =>
							resolve({ stdout, stderr: `${stderr}\n${command} timed out after ${limit}ms`, code: null }),
						);
					}, limit)
				: undefined;

		const onAbort = () => kill();
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			options.onOutput?.(chunk.toString());
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
			options.onOutput?.(chunk.toString());
		});
		child.on("error", (error) => finish(() => reject(error)));
		// exit means the command itself is done; close waits for stdio that a
		// lingering grandchild may hold open indefinitely.
		child.on("exit", (code) => {
			drain = setTimeout(() => finish(() => resolve({ stdout, stderr, code })), OUTPUT_DRAIN_MS);
		});
		child.on("close", (code) => finish(() => resolve({ stdout, stderr, code })));
	});
}

/**
 * Return every container runtime that is installed and responsive.
 *
 * All of them are returned rather than just the first: with both docker and
 * podman installed, committing to the first responsive one silently misses a
 * container created by the other.
 */
export async function detectRuntimes(config?: DevcontainerExtensionConfig): Promise<RuntimeSpec[]> {
	const args = config?.runtimeArgs ?? [];
	const execArgs = config?.execArgs ?? [];
	const bins = config?.runtime ? [config.runtime] : DEFAULT_RUNTIME_BINS;

	const found: RuntimeSpec[] = [];
	for (const bin of bins) {
		try {
			const result = await runHost(bin, [...args, "ps", "--format", "{{.ID}}"]);
			if (result.code === 0) found.push({ bin, args, execArgs });
		} catch {
			// Binary missing; try the next runtime.
		}
	}
	return found;
}

interface InspectResult {
	Name?: string;
	Mounts?: Array<{ Source?: string; Destination?: string }>;
	Config?: { User?: string; Labels?: Record<string, string> };
}

/** Read remoteUser/containerUser out of the devcontainer.metadata label. */
function userFromMetadataLabel(labels: Record<string, string> | undefined): string | undefined {
	const raw = labels?.["devcontainer.metadata"];
	if (!raw) return undefined;
	try {
		const entries = JSON.parse(raw);
		if (!Array.isArray(entries)) return undefined;
		let user: string | undefined;
		for (const entry of entries) {
			if (entry && typeof entry === "object") {
				const candidate = (entry as { remoteUser?: unknown; containerUser?: unknown }).remoteUser;
				const fallback = (entry as { containerUser?: unknown }).containerUser;
				if (typeof candidate === "string") user = candidate;
				else if (typeof fallback === "string") user = fallback;
			}
		}
		return user;
	} catch {
		return undefined;
	}
}

/** Query running container ids matching a label filter. */
async function psByLabel(runtime: RuntimeSpec, label: string): Promise<string[]> {
	const result = await runHost(runtime.bin, [
		...runtime.args,
		"ps",
		"--no-trunc",
		"--filter",
		`label=${label}`,
		"--format",
		"{{.ID}}",
	]);
	if (result.code !== 0) return [];
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

/**
 * Find the container for a workspace, and the runtimes that answered.
 *
 * Each candidate runtime is asked one question, in parallel: list containers
 * labelled for this workspace. That answers both whether the runtime is usable
 * and whether it has our container, where probing availability separately would
 * double the round trips. Container CLIs are slow enough that the number of
 * invocations is what startup time is made of.
 */
export async function discoverContainer(
	config: DevcontainerExtensionConfig | undefined,
	devcontainer: DevcontainerConfig,
	known?: ContainerTarget | null,
): Promise<{ runtimes: RuntimeSpec[]; target: ContainerTarget | null }> {
	const args = config?.runtimeArgs ?? [];
	const execArgs = config?.execArgs ?? [];
	const bins = config?.runtime ? [config.runtime] : DEFAULT_RUNTIME_BINS;

	const probes = await Promise.all(
		bins.map(async (bin) => {
			const runtime: RuntimeSpec = { bin, args, execArgs };
			try {
				const ids = await psByLabel(runtime, `devcontainer.local_folder=${devcontainer.workspaceFolder}`);
				return { runtime, usable: true, ids };
			} catch {
				return { runtime, usable: false, ids: [] as string[] };
			}
		}),
	);

	const runtimes = probes.filter((probe) => probe.usable).map((probe) => probe.runtime);
	const hit = probes.find((probe) => probe.ids.length > 0);
	if (!hit) return { runtimes, target: null };

	// Re-checking a container we have already inspected: its user, shell and
	// ripgrep do not change while it runs, so skip that round trip.
	if (known && hit.ids.includes(known.id)) return { runtimes, target: known };

	const target = await inspectContainer(hit.runtime, hit.ids, devcontainer);
	return { runtimes, target };
}

/**
 * Locate the running container for a devcontainer workspace.
 * Returns null when no matching container is currently running.
 */
export async function findRunningContainer(
	runtimes: RuntimeSpec | RuntimeSpec[],
	devcontainer: DevcontainerConfig,
): Promise<ContainerTarget | null> {
	for (const runtime of Array.isArray(runtimes) ? runtimes : [runtimes]) {
		const target = await findInRuntime(runtime, devcontainer);
		if (target) return target;
	}
	return null;
}

async function findInRuntime(
	runtime: RuntimeSpec,
	devcontainer: DevcontainerConfig,
): Promise<ContainerTarget | null> {
	const { workspaceFolder, configPath } = devcontainer;

	// config_file is the most specific match; local_folder covers configs in
	// .devcontainer subfolders where the recorded config path may differ.
	let ids = await psByLabel(runtime, `devcontainer.config_file=${configPath}`);
	if (ids.length === 0) ids = await psByLabel(runtime, `devcontainer.local_folder=${workspaceFolder}`);
	if (ids.length === 0) return null;
	return inspectContainer(runtime, ids, devcontainer);
}

/** Inspect the matching container and probe it once for user, shell and rg. */
async function inspectContainer(
	runtime: RuntimeSpec,
	ids: string[],
	devcontainer: DevcontainerConfig,
): Promise<ContainerTarget | null> {
	const { workspaceFolder, configPath } = devcontainer;
	const id = ids[0];
	const inspected = await runHost(runtime.bin, [...runtime.args, "inspect", id, "--format", "{{json .}}"]);
	if (inspected.code !== 0) return null;

	let details: InspectResult;
	try {
		details = JSON.parse(inspected.stdout.trim());
	} catch {
		return null;
	}

	const mount = details.Mounts?.find((entry) => entry.Source === workspaceFolder && entry.Destination);
	const containerWorkspace =
		mount?.Destination ?? path.posix.join("/workspaces", path.basename(workspaceFolder));

	const configuredUser =
		devcontainer.config.remoteUser ??
		devcontainer.config.containerUser ??
		userFromMetadataLabel(details.Config?.Labels) ??
		(details.Config?.User || undefined);

	const target: ContainerTarget = {
		runtime,
		id,
		name: (details.Name ?? id).replace(/^\//, ""),
		hostWorkspace: workspaceFolder,
		containerWorkspace,
		user: configuredUser,
		configPath,
		shell: "sh",
		hasRipgrep: false,
	};

	// One exec answers three questions: whether the configured user works, and
	// whether bash and ripgrep are present. Asking separately would cost three
	// round trips through the container CLI.
	const probeCommand = [
		"sh",
		"-c",
		"command -v bash >/dev/null 2>&1 && echo bash; command -v rg >/dev/null 2>&1 && echo rg; exit 0",
	];
	let probe = await containerExec(target, probeCommand).catch(() => undefined);
	if (target.user && (!probe || probe.exitCode !== 0)) {
		// The configured user did not work; fall back to the image's own user.
		target.user = undefined;
		probe = await containerExec(target, probeCommand).catch(() => undefined);
	}
	const found = probe?.stdout.toString().split("\n").map((line) => line.trim()) ?? [];
	target.shell = found.includes("bash") ? "bash" : "sh";
	target.hasRipgrep = found.includes("rg");

	return target;
}

/**
 * True when an exec failed because the container is no longer usable, rather
 * than because the command itself failed.
 */
export function isContainerGoneError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /no such container|container state improper|is not running|not running/i.test(message);
}

/** True while the container is still running. */
export async function isContainerRunning(target: ContainerTarget): Promise<boolean> {
	try {
		const result = await runHost(target.runtime.bin, [...target.runtime.args, "inspect", target.id, "--format", "{{.State.Running}}"]);
		return result.code === 0 && result.stdout.trim() === "true";
	} catch {
		return false;
	}
}

/** Extra container facts shown in the /devcontainer menu. */
export interface ContainerDetails {
	shortId: string;
	image?: string;
	status?: string;
	startedAt?: string;
}

export async function getContainerDetails(target: ContainerTarget): Promise<ContainerDetails> {
	const shortId = target.id.slice(0, 12);
	try {
		const result = await runHost(target.runtime.bin, [...target.runtime.args, "inspect", target.id, "--format", "{{json .}}"]);
		if (result.code !== 0) return { shortId };
		const parsed = JSON.parse(result.stdout.trim());
		return {
			shortId,
			// docker reports Config.Image; podman reports ImageName.
			image: parsed?.Config?.Image ?? parsed?.ImageName,
			status: parsed?.State?.Status,
			startedAt: parsed?.State?.StartedAt,
		};
	} catch {
		return { shortId };
	}
}

/**
 * Execute argv inside the container.
 *
 * Throws "aborted" when the signal fires and `timeout:<seconds>` on timeout,
 * matching the error contract expected by pi's built-in shell tools.
 */
export function containerExec(
	target: ContainerTarget,
	argv: string[],
	options: ExecOptions = {},
): Promise<ExecResult> {
	const { cwd, input, signal, timeout, onData, shouldStop, separateStderr } = options;

	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}

		const args = [...target.runtime.args, "exec"];
		if (input !== undefined) args.push("-i");
		if (target.user) args.push("--user", target.user);
		if (cwd) args.push("-w", cwd);
		args.push(...target.runtime.execArgs, target.id, ...argv);

		const child = spawn(target.runtime.bin, args, {
			stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
		});

		const stdoutChunks: Buffer[] = [];
		let stderr = "";
		let timedOut = false;
		let stopped = false;

		const timer =
			timeout && timeout > 0
				? setTimeout(() => {
						timedOut = true;
						child.kill("SIGKILL");
					}, timeout * 1000)
				: undefined;

		const onAbort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", onAbort, { once: true });

		let drain: NodeJS.Timeout | undefined;
		let settled = false;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			if (drain) clearTimeout(drain);
			signal?.removeEventListener("abort", onAbort);
		};
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			fn();
		};

		child.stdout.on("data", (chunk: Buffer) => {
			if (onData) onData(chunk);
			else stdoutChunks.push(chunk);
			if (shouldStop?.() && !stopped) {
				stopped = true;
				child.kill("SIGKILL");
			}
		});

		child.stderr.on("data", (chunk: Buffer) => {
			if (onData && !separateStderr) onData(chunk);
			else stderr += chunk.toString();
		});

		child.on("error", (error) => {
			settle(() => reject(new Error(`Failed to run ${target.runtime.bin} exec: ${error.message}`)));
		});

		if (input !== undefined) {
			child.stdin.on("error", () => {
				// Ignore EPIPE when the process exits before consuming stdin.
			});
			child.stdin.end(input);
		}

		const conclude = (code: number | null) =>
			settle(() => {
				if (signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}
				if (timedOut) {
					reject(new Error(`timeout:${timeout}`));
					return;
				}
				resolve({ stdout: Buffer.concat(stdoutChunks), stderr, exitCode: stopped ? 0 : code });
			});

		// Guard, not a fix for anything observed: podman closes an exec stream
		// when the command exits, even with something still running inside the
		// container. A runtime that did not would hang the tool call forever,
		// and bash has no timeout unless the model sets one.
		child.on("exit", (code) => {
			drain = setTimeout(() => conclude(code), OUTPUT_DRAIN_MS);
		});
		child.on("close", (code) => conclude(code));
	});
}

/** Run argv and throw when it exits non-zero. */
export async function containerExecOk(
	target: ContainerTarget,
	argv: string[],
	options: ExecOptions = {},
): Promise<Buffer> {
	const result = await containerExec(target, argv, options);
	if (result.exitCode !== 0) {
		const message = result.stderr.trim() || `command failed (exit ${result.exitCode}): ${argv.join(" ")}`;
		throw new Error(message);
	}
	return result.stdout;
}

/** Check whether a binary is available inside the container. */
export async function containerHasCommand(target: ContainerTarget, command: string): Promise<boolean> {
	try {
		const result = await containerExec(target, ["sh", "-c", `command -v ${command} >/dev/null 2>&1`]);
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * The container path for a host path inside the workspace.
 *
 * This is the only host-to-container mapping in the extension, and it is used
 * for two things: working out the session's directory once at startup, and
 * telling the model the container path when it names a host one. Tool calls
 * are never rewritten with it — see toContainerPath in operations.ts.
 */
export function containerPathFor(target: ContainerTarget, hostPath: string): string {
	if (target.hostWorkspace === target.containerWorkspace) return hostPath;
	const relative = path.relative(target.hostWorkspace, hostPath);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return target.containerWorkspace;
	return path.posix.join(target.containerWorkspace, relative.split(path.sep).join(path.posix.sep));
}

export interface SessionDirectory {
	/** Where routed tool calls and ! commands run. */
	directory: string;
	/** The mapped directory, when it turned out not to exist in the container. */
	missing?: string;
}

/**
 * Decide the container directory routed calls run in, and check it is there.
 *
 * Mapping the session directory assumes the container has the same subtree,
 * which is true for a bind-mounted workspace and not for a devcontainer that
 * clones into a volume or bakes its sources into the image. Left unchecked,
 * every routed call would fail with the runtime's own wording for a missing
 * working directory — "OCI runtime attempted to invoke a command that was not
 * found" — which reads like a missing program. One probe at startup turns that
 * into a single, accurate warning, and the workspace root is used instead.
 */
export async function resolveSessionDirectory(
	target: ContainerTarget,
	localCwd: string,
	probe: (directory: string) => Promise<boolean> = async (directory) => {
		const result = await containerExec(target, ["test", "-d", directory]).catch(() => undefined);
		return result?.exitCode === 0;
	},
): Promise<SessionDirectory> {
	const mapped = containerPathFor(target, localCwd);
	if (mapped === target.containerWorkspace) return { directory: mapped };
	return (await probe(mapped))
		? { directory: mapped }
		: { directory: target.containerWorkspace, missing: mapped };
}

/** Start a stopped devcontainer using the devcontainer CLI. */
export async function devcontainerUp(
	workspaceFolder: string,
	config?: DevcontainerExtensionConfig,
	signal?: AbortSignal,
	configPath?: string,
	onOutput?: (chunk: string) => void,
): Promise<{ ok: boolean; output: string }> {
	const bin = config?.devcontainerPath ?? "devcontainer";
	const extra = config?.upArgs ?? [];
	// The CLI only auto-discovers .devcontainer/devcontainer.json and
	// .devcontainer.json. Pass the config we actually discovered so a
	// .devcontainer/<folder>/devcontainer.json layout starts the same container
	// this extension is targeting.
	const args = ["up", "--workspace-folder", workspaceFolder];
	if (configPath && !extra.includes("--config")) args.push("--config", configPath);
	args.push(...extra);
	try {
		// Building an image can take minutes, so this one is not bounded.
		const result = await runHost(bin, args, { signal, timeoutMs: 0, onOutput });
		return { ok: result.code === 0, output: `${result.stdout}\n${result.stderr}`.trim() };
	} catch (error) {
		return { ok: false, output: error instanceof Error ? error.message : String(error) };
	}
}
