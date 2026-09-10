/**
 * Container-backed implementations of pi's pluggable tool operations.
 *
 * Paths crossing this boundary are container paths. Absolute ones are used as
 * written and relative ones resolve against the session's container directory;
 * nothing is translated from the host, so a path always names the file the
 * command will actually open.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import {
	type BashOperations,
	DEFAULT_MAX_BYTES,
	type EditOperations,
	type FindOperations,
	formatSize,
	type GrepToolDetails,
	type GrepToolInput,
	type LsOperations,
	type ReadOperations,
	truncateHead,
	truncateLine,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { type ContainerTarget, containerExec, containerExecOk } from "./container.ts";

const DEFAULT_GREP_LIMIT = 100;
const SKIP_DIRS = [".git", "node_modules"];

export interface GrepCapabilities {
	/** Whether ripgrep is available inside the container */
	hasRipgrep: boolean;
	/** Container directory relative paths resolve against; defaults to the workspace */
	cwd?: string;
}

function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function toPosix(value: string): string {
	return value.split(path.sep).join(path.posix.sep);
}

/**
 * Resolve a tool's path argument to an absolute container path.
 *
 * An absolute path is taken as written: it means the container's copy, the
 * same as `/etc/hosts` does. There is deliberately no translation of host
 * workspace paths, because it cannot be done honestly — a devcontainer that
 * clones into a volume, or bakes its sources into the image, has no bind mount
 * back to the host, so rewriting `/home/me/app/x` to `/workspaces/app/x` would
 * silently address a different copy of the file. Mount the workspace at the
 * same path on both sides if you want one spelling to work everywhere.
 *
 * Relative paths resolve against the session's directory in the container,
 * which is what makes `read src/a.ts` mean what it does on the host.
 */
export function toContainerPath(target: ContainerTarget, inputPath: string, base?: string): string {
	const root = base ?? target.containerWorkspace;
	const trimmed = stripAtPrefix(inputPath.trim());
	if (!trimmed) return root;

	if (path.isAbsolute(trimmed) || path.posix.isAbsolute(toPosix(trimmed))) {
		return path.posix.resolve("/", toPosix(trimmed));
	}
	return path.posix.resolve(root, toPosix(trimmed));
}

export function createContainerReadOps(target: ContainerTarget): ReadOperations {
	return {
		readFile: (filePath) => containerExecOk(target, ["cat", "--", toContainerPath(target, filePath)]),
		access: async (filePath) => {
			const result = await containerExec(target, ["test", "-r", toContainerPath(target, filePath)]);
			if (result.exitCode !== 0) {
				throw new Error(`Cannot read path in container: ${toContainerPath(target, filePath)}`);
			}
		},
		detectImageMimeType: async (filePath) => {
			const ext = path.posix.extname(toContainerPath(target, filePath)).toLowerCase();
			if (ext === ".png") return "image/png";
			if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
			if (ext === ".gif") return "image/gif";
			if (ext === ".webp") return "image/webp";
			return null;
		},
	};
}

export function createContainerWriteOps(target: ContainerTarget): WriteOperations {
	return {
		writeFile: async (filePath, content) => {
			// Pipe through stdin so content never passes through shell quoting.
			await containerExecOk(target, ["sh", "-c", 'cat > "$1"', "sh", toContainerPath(target, filePath)], {
				input: content,
			});
		},
		mkdir: async (dirPath) => {
			await containerExecOk(target, ["mkdir", "-p", "--", toContainerPath(target, dirPath)]);
		},
	};
}

export function createContainerEditOps(target: ContainerTarget): EditOperations {
	const read = createContainerReadOps(target);
	const write = createContainerWriteOps(target);
	return {
		readFile: read.readFile,
		writeFile: write.writeFile,
		access: async (filePath) => {
			const containerPath = toContainerPath(target, filePath);
			const result = await containerExec(target, [
				"sh",
				"-c",
				'test -r "$1" && test -w "$1"',
				"sh",
				containerPath,
			]);
			if (result.exitCode !== 0) {
				throw new Error(`Cannot read and write path in container: ${containerPath}`);
			}
		},
	};
}

export function createContainerLsOps(target: ContainerTarget): LsOperations {
	return {
		exists: async (filePath) => {
			const result = await containerExec(target, ["test", "-e", toContainerPath(target, filePath)]);
			return result.exitCode === 0;
		},
		stat: async (filePath) => {
			const containerPath = toContainerPath(target, filePath);
			const existsResult = await containerExec(target, ["test", "-e", containerPath]);
			if (existsResult.exitCode !== 0) throw new Error(`Path not found in container: ${containerPath}`);
			const dirResult = await containerExec(target, ["test", "-d", containerPath]);
			const isDir = dirResult.exitCode === 0;
			return { isDirectory: () => isDir };
		},
		readdir: async (dirPath) => {
			const containerPath = toContainerPath(target, dirPath);
			// NUL-delimited names survive spaces and newlines; fall back for non-GNU find.
			const result = await containerExec(target, [
				"find",
				containerPath,
				"-mindepth",
				"1",
				"-maxdepth",
				"1",
				"-printf",
				"%f\\0",
			]);
			if (result.exitCode === 0) {
				return result.stdout.toString().split("\0").filter(Boolean);
			}
			const fallback = await containerExecOk(target, ["ls", "-A", "-1", "--", containerPath]);
			return fallback.toString().split("\n").filter(Boolean);
		},
	};
}

/** Match a relative path against a tool glob, mirroring fd's basename behavior. */
function matchesToolGlob(relativePath: string, pattern: string): boolean {
	const normalized = toPosix(pattern);
	if (normalized.includes("/")) {
		return (
			path.posix.matchesGlob(relativePath, normalized) ||
			path.posix.matchesGlob(relativePath, `**/${normalized}`)
		);
	}
	return path.posix.matchesGlob(path.posix.basename(relativePath), normalized);
}

export function createContainerFindOps(target: ContainerTarget): FindOperations {
	return {
		exists: async (filePath) => {
			const result = await containerExec(target, ["test", "-e", toContainerPath(target, filePath)]);
			return result.exitCode === 0;
		},
		glob: async (pattern, cwd, options) => {
			const root = toContainerPath(target, cwd);
			const argv = ["find", root];
			// Prune noisy directories before matching.
			argv.push("(");
			SKIP_DIRS.forEach((dir, index) => {
				if (index > 0) argv.push("-o");
				argv.push("-name", dir);
			});
			argv.push(")", "-prune", "-o", "-type", "f", "-print0");

			const result = await containerExec(target, argv);
			const entries = result.stdout.toString().split("\0").filter(Boolean);

			const matches: string[] = [];
			for (const entry of entries) {
				const relative = path.posix.relative(root, entry);
				if (!relative || relative.startsWith("..")) continue;
				if (options.ignore.some((ignored) => path.posix.matchesGlob(relative, ignored.replace(/^\*\*\//, "")))) {
					continue;
				}
				if (matchesToolGlob(relative, pattern)) matches.push(entry);
				if (matches.length >= options.limit) break;
			}
			return matches;
		},
	};
}

/**
 * Session metadata pi documents for shell commands, and which its own bash tool
 * sets. Forwarded so a command behaves the same routed or not.
 *
 * PI_SESSION_FILE is deliberately absent: it is a host path, so inside the
 * container it would name a file that does not exist. Host variables that
 * merely happen to start with PI_ are not forwarded either; the container's
 * environment is otherwise its own.
 */
const FORWARDED_ENV = ["PI_SESSION_ID", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"];

/**
 * Shell operations that run in the container.
 *
 * The container directory is passed in rather than derived from the `cwd` pi
 * supplies: for the routed bash tool that value is already a container path,
 * but for `!` commands it is pi's own host working directory, and translating
 * host paths is exactly what this extension no longer does. The session's
 * container directory is worked out once, at startup.
 */
export function createContainerBashOps(
	target: ContainerTarget,
	shell: string,
	containerCwd: string = target.containerWorkspace,
): BashOperations {
	return {
		exec: async (command, _cwd, { onData, signal, timeout, env }) => {
			const envArgs: string[] = [];
			if (env) {
				for (const key of FORWARDED_ENV) {
					const value = env[key];
					if (typeof value === "string" && value) envArgs.push(`${key}=${value}`);
				}
			}
			const inner = envArgs.length > 0 ? `export ${envArgs.map(shellQuote).join(" ")}; ${command}` : command;
			const result = await containerExec(target, [shell, "-lc", inner], {
				cwd: containerCwd,
				signal,
				timeout,
				onData,
			});
			return { exitCode: result.exitCode };
		},
	};
}

/**
 * Run a pre-parsed argv on the host with no shell involved.
 *
 * This is the second half of the host-command guarantee: even if the parser in
 * routing.ts were bypassed, there is no shell here to interpret operators, so
 * only the named program can run.
 */
export function createHostArgvOperations(argv: string[]): BashOperations {
	return {
		exec: (_command, cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}
				const child = spawn(argv[0], argv.slice(1), {
					cwd,
					stdio: ["ignore", "pipe", "pipe"],
					shell: false,
				});

				let timedOut = false;
				const timer =
					timeout && timeout > 0
						? setTimeout(() => {
								timedOut = true;
								child.kill("SIGKILL");
							}, timeout * 1000)
						: undefined;
				const onAbort = () => child.kill("SIGKILL");
				signal?.addEventListener("abort", onAbort, { once: true });
				const cleanup = () => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
				};

				child.stdout.on("data", onData);
				child.stderr.on("data", onData);
				child.on("error", (error) => {
					cleanup();
					reject(new Error(`failed to run ${argv[0]} on the host: ${error.message}`));
				});
				child.on("close", (code) => {
					cleanup();
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			}),
	};
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface GrepMatch {
	filePath: string;
	lineNumber: number;
	lineText: string;
}

/** Build the in-container search command; rg and grep share one output format. */
function buildGrepArgv(params: GrepToolInput, searchPath: string, hasRipgrep: boolean): string[] {
	if (hasRipgrep) {
		// --with-filename is required: both rg and grep omit the name for a single file.
		const argv = [
			"rg",
			"--line-number",
			"--null",
			"--with-filename",
			"--no-heading",
			"--color=never",
			"--hidden",
			"--glob",
			"!.git",
		];
		if (params.ignoreCase) argv.push("--ignore-case");
		if (params.literal) argv.push("--fixed-strings");
		if (params.glob) argv.push("--glob", params.glob);
		argv.push("-e", params.pattern, "--", searchPath);
		return argv;
	}

	const argv = ["grep", "-rnIZH"];
	for (const dir of SKIP_DIRS) argv.push(`--exclude-dir=${dir}`);
	if (params.ignoreCase) argv.push("-i");
	if (params.literal) argv.push("-F");
	if (params.glob) argv.push(`--include=${params.glob}`);
	argv.push("-e", params.pattern, "--", searchPath);
	return argv;
}

/** Parse `path\0lineNumber:text` records emitted by both rg --null and grep -Z. */
function parseGrepOutput(raw: string, limit: number): { matches: GrepMatch[]; limitReached: boolean } {
	const matches: GrepMatch[] = [];
	for (const line of raw.split("\n")) {
		if (!line) continue;
		const nulIndex = line.indexOf("\0");
		if (nulIndex === -1) continue;
		const filePath = line.slice(0, nulIndex);
		const rest = line.slice(nulIndex + 1);
		const colonIndex = rest.indexOf(":");
		if (colonIndex === -1) continue;
		const lineNumber = Number.parseInt(rest.slice(0, colonIndex), 10);
		if (!Number.isFinite(lineNumber)) continue;
		if (matches.length >= limit) return { matches, limitReached: true };
		matches.push({ filePath, lineNumber, lineText: rest.slice(colonIndex + 1) });
	}
	return { matches, limitReached: false };
}

export interface GrepResult {
	content: Array<{ type: "text"; text: string }>;
	details: GrepToolDetails | undefined;
}

/**
 * Run grep inside the container and format results exactly like pi's built-in
 * grep tool, including context blocks, truncation, and notices.
 */
export async function executeContainerGrep(
	target: ContainerTarget,
	params: GrepToolInput,
	capabilities: GrepCapabilities,
	signal?: AbortSignal,
): Promise<GrepResult> {
	const base = capabilities.cwd ?? target.containerWorkspace;
	const searchPath = toContainerPath(target, params.path ?? ".", base);

	const existsResult = await containerExec(target, ["test", "-e", searchPath], { signal });
	if (existsResult.exitCode !== 0) throw new Error(`Path not found: ${searchPath}`);
	const dirResult = await containerExec(target, ["test", "-d", searchPath], { signal });
	const isDirectory = dirResult.exitCode === 0;

	const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
	const contextValue = params.context && params.context > 0 ? params.context : 0;

	let raw = "";
	let recordCount = 0;
	const searchResult = await containerExec(target, buildGrepArgv(params, searchPath, capabilities.hasRipgrep), {
		cwd: base,
		signal,
		separateStderr: true,
		onData: (chunk) => {
			// Count per chunk; re-splitting the whole buffer each time is quadratic.
			const text = chunk.toString();
			raw += text;
			recordCount += text.split("\n").length - 1;
		},
		shouldStop: () => recordCount > effectiveLimit,
	});

	if (searchResult.exitCode !== 0 && searchResult.exitCode !== 1 && raw.length === 0) {
		const message = searchResult.stderr.trim();
		if (message) throw new Error(message);
	}

	const { matches, limitReached } = parseGrepOutput(raw, effectiveLimit);
	if (matches.length === 0) {
		return { content: [{ type: "text", text: "No matches found" }], details: undefined };
	}

	const matchLimitReached = limitReached || matches.length >= effectiveLimit;
	let linesTruncated = false;

	const formatPath = (filePath: string): string => {
		if (isDirectory) {
			const relative = path.posix.relative(searchPath, filePath);
			if (relative && !relative.startsWith("..")) return relative;
		}
		return path.posix.basename(filePath);
	};

	const fileCache = new Map<string, string[]>();
	const getFileLines = async (filePath: string): Promise<string[]> => {
		let lines = fileCache.get(filePath);
		if (!lines) {
			try {
				const content = await containerExecOk(target, ["cat", "--", filePath], { signal });
				lines = content.toString().replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			} catch {
				lines = [];
			}
			fileCache.set(filePath, lines);
		}
		return lines;
	};

	const outputLines: string[] = [];
	for (const match of matches) {
		const relativePath = formatPath(match.filePath);

		if (contextValue === 0) {
			const sanitized = match.lineText.replace(/\r/g, "").replace(/\n$/, "");
			const { text, wasTruncated } = truncateLine(sanitized);
			if (wasTruncated) linesTruncated = true;
			outputLines.push(`${relativePath}:${match.lineNumber}: ${text}`);
			continue;
		}

		const lines = await getFileLines(match.filePath);
		if (lines.length === 0) {
			outputLines.push(`${relativePath}:${match.lineNumber}: (unable to read file)`);
			continue;
		}
		const start = Math.max(1, match.lineNumber - contextValue);
		const end = Math.min(lines.length, match.lineNumber + contextValue);
		for (let current = start; current <= end; current++) {
			const sanitized = (lines[current - 1] ?? "").replace(/\r/g, "");
			const { text, wasTruncated } = truncateLine(sanitized);
			if (wasTruncated) linesTruncated = true;
			if (current === match.lineNumber) outputLines.push(`${relativePath}:${current}: ${text}`);
			else outputLines.push(`${relativePath}-${current}- ${text}`);
		}
	}

	const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;
	const details: GrepToolDetails = {};
	const notices: string[] = [];

	if (matchLimitReached) {
		notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
		details.matchLimitReached = effectiveLimit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (linesTruncated) {
		notices.push("Some lines truncated. Use read tool to see full lines");
		details.linesTruncated = true;
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

	return {
		content: [{ type: "text", text: output }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}
