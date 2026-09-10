/**
 * Extension configuration, read from pi's settings files.
 *
 * Settings live under a top-level "devcontainer" key in pi's settings files:
 *
 *   1. user     ~/<configDir>/agent/settings.json
 *   2. project  <cwd>/<configDir>/settings.json
 *
 * Project settings are additionally restricted: the agent can write files in
 * the workspace, so anything that decides which binary runs on the host would
 * be self-granting. Only PROJECT_SAFE_KEYS may come from a project.
 *
 * This module deliberately imports nothing from pi so that container.ts and the
 * dev/ helpers stay usable without pi's packages installed.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseJsonc } from "./discovery.ts";

/** Top-level settings.json key owned by this extension. */
export const SETTINGS_KEY = "devcontainer";

/** Built-in tools this extension is able to route. */
export const ROUTABLE_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;

export interface DevcontainerExtensionConfig {
	/** Route tool calls into the container. Set false to stay on the host. */
	enabled: boolean;
	/** Container CLI to use. Defaults to probing docker then podman. */
	runtime?: string;
	/** Global args placed before the subcommand, e.g. ["--context", "desktop"] */
	runtimeArgs: string[];
	/** Extra args for `exec`, e.g. ["--env", "FOO=bar"] */
	execArgs: string[];
	/** devcontainer CLI used by /devcontainer up */
	devcontainerPath: string;
	/** Extra args for `devcontainer up`, e.g. ["--docker-path", "/usr/local/bin/docker"] */
	upArgs: string[];
	/** Commands that must run on the host, e.g. ["tuicr", "herdr"] */
	hostCommands: string[];
	/**
	 * Host paths a routed session may read, e.g. ["~/reference"]. Read-only:
	 * only read, ls, find and grep see them, never write, edit or bash.
	 *
	 * pi's own skills, extensions and documentation are always readable; they
	 * are named in the system prompt by host path, so a routed session that
	 * could not open them would be told to use skills it cannot load.
	 */
	readableHostPaths: string[];
	/**
	 * gitignore-style patterns for what must stay unreadable inside those roots,
	 * e.g. ["*.env", ".ssh/", "!public/*.pem"]. Empty by default: the roots are
	 * the boundary, and a built-in list of names that look like secrets would be
	 * both wrong about ordinary files and incomplete.
	 */
	unreadableHostPatterns: string[];
	/** Which built-in tools this extension claims and routes */
	tools: string[];
	/** Where user `!` commands run: in the container, or always on the host */
	userBash: "container" | "host";
	/**
	 * Refuse to run tool calls at all when there is no container, instead of
	 * falling back to the host. For people who use this for isolation rather
	 * than convenience.
	 */
	requireContainer: boolean;
}

export interface ConfigSource {
	label: string;
	path: string;
	applied: string[];
}

export interface LoadedConfig {
	config: DevcontainerExtensionConfig;
	sources: ConfigSource[];
	/**
	 * Skill and extension paths named in the user's own settings.json, so paths
	 * pi was pointed at explicitly are readable alongside the default locations.
	 */
	resourcePaths: string[];
}

export const DEFAULT_CONFIG: DevcontainerExtensionConfig = {
	enabled: true,
	runtimeArgs: [],
	execArgs: [],
	devcontainerPath: "devcontainer",
	upArgs: [],
	hostCommands: [],
	readableHostPaths: [],
	unreadableHostPatterns: [],
	tools: [...ROUTABLE_TOOLS],
	userBash: "container",
	requireContainer: false,
};

/**
 * Keys a project may set. Everything else names or influences a host
 * executable, so it must come from the user's own settings.
 */
export const PROJECT_SAFE_KEYS = new Set(["enabled"]);

const KNOWN_KEYS = new Set([
	"enabled",
	"runtime",
	"runtimeArgs",
	"execArgs",
	"devcontainerPath",
	"upArgs",
	"hostCommands",
	"readableHostPaths",
	"unreadableHostPatterns",
	"tools",
	"requireContainer",
	"userBash",
]);

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((entry): entry is string => typeof entry === "string");
	return items.length === value.length ? items : undefined;
}

/** Apply one raw settings object over a config, reporting the keys that took effect. */
function applyLayer(
	target: DevcontainerExtensionConfig,
	raw: unknown,
	allowedKeys?: ReadonlySet<string>,
): { applied: string[]; unknown: string[]; refused: string[] } {
	const applied: string[] = [];
	const unknownKeys: string[] = [];
	const refused: string[] = [];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { applied, unknown: unknownKeys, refused };
	}

	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!KNOWN_KEYS.has(key)) {
			unknownKeys.push(key);
			continue;
		}
		if (allowedKeys && !allowedKeys.has(key)) {
			refused.push(key);
			continue;
		}
		switch (key) {
			case "enabled":
			case "requireContainer":
				if (typeof value === "boolean") {
					target[key] = value;
					applied.push(key);
				}
				break;
			case "userBash":
				if (value === "container" || value === "host") {
					target.userBash = value;
					applied.push(key);
				} else {
					console.warn(`devcontainer: "userBash" must be "container" or "host"; ignoring ${JSON.stringify(value)}`);
				}
				break;
			case "runtime":
			case "devcontainerPath":
				if (typeof value === "string" && value.trim()) {
					target[key] = value.trim();
					applied.push(key);
				}
				break;
			case "runtimeArgs":
			case "execArgs":
			case "upArgs":
			case "hostCommands":
			case "readableHostPaths":
			case "unreadableHostPatterns":
			case "tools": {
				const items = asStringArray(value);
				if (items) {
					target[key] = items;
					applied.push(key);
				}
				break;
			}
		}
	}
	return { applied, unknown: unknownKeys, refused };
}

/** Read a settings.json, if it is there and parses. */
function readSettingsFile(filePath: string): Record<string, unknown> | undefined {
	try {
		const parsed = parseJsonc(readFileSync(filePath, "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Skill and extension paths from pi's own top-level settings keys.
 *
 * These are not this extension's settings; they are read only to learn where
 * pi's resources live, so a skill installed from a local checkout is readable
 * too. Values may be files or directories, and may start with "~".
 */
function resourcePathsFrom(settings: Record<string, unknown> | undefined): string[] {
	const found: string[] = [];
	for (const key of ["skills", "extensions"]) {
		const entries = settings?.[key];
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			if (typeof entry === "string" && entry.trim()) found.push(entry.trim());
		}
	}
	return found;
}

export interface LoadConfigOptions {
	/** pi's config directory name, normally ".pi" */
	configDirName: string;
	/** Working directory pi was started in; project settings are read from here */
	cwd: string;
	/** Whether project settings may be honored */
	trusted: boolean;
	/** Override the home directory; for tests */
	home?: string;
}

/** Merge configuration from pi's user and project settings files. */
export function loadConfig(options: LoadConfigOptions): LoadedConfig {
	const config: DevcontainerExtensionConfig = {
		...DEFAULT_CONFIG,
		runtimeArgs: [...DEFAULT_CONFIG.runtimeArgs],
		execArgs: [...DEFAULT_CONFIG.execArgs],
		upArgs: [...DEFAULT_CONFIG.upArgs],
		hostCommands: [...DEFAULT_CONFIG.hostCommands],
		readableHostPaths: [...DEFAULT_CONFIG.readableHostPaths],
		unreadableHostPatterns: [...DEFAULT_CONFIG.unreadableHostPatterns],
		tools: [...DEFAULT_CONFIG.tools],
	};
	const sources: ConfigSource[] = [];
	const resourcePaths: string[] = [];

	const record = (label: string, filePath: string, allowedKeys?: ReadonlySet<string>): void => {
		const settings = readSettingsFile(filePath);
		const raw = settings?.[SETTINGS_KEY];
		// pi's own resource paths are read from user settings only: a project's
		// are inside the workspace, which the container already sees.
		if (!allowedKeys) resourcePaths.push(...resourcePathsFrom(settings));
		if (raw === undefined) return;
		const { applied, unknown, refused } = applyLayer(config, raw, allowedKeys);
		sources.push({ label, path: filePath, applied });
		if (unknown.length > 0) {
			console.warn(
				`devcontainer: ignoring unknown key(s) under "${SETTINGS_KEY}" in ${filePath}: ${unknown.join(", ")}`,
			);
		}
		if (refused.length > 0) {
			console.warn(
				`devcontainer: ignoring ${refused.join(", ")} in ${filePath}; ` +
					"these decide what runs on the host or what it may read, and are only taken from user settings",
			);
		}
	};

	const home = options.home ?? homedir();
	record("user settings", path.join(home, options.configDirName, "agent", "settings.json"));

	const unknownTools = config.tools.filter((name) => !ROUTABLE_TOOLS.includes(name as never));
	if (unknownTools.length > 0) {
		console.warn(`devcontainer: ignoring unroutable tool(s) in "tools": ${unknownTools.join(", ")}`);
		config.tools = config.tools.filter((name) => ROUTABLE_TOOLS.includes(name as never));
	}

	if (options.trusted) {
		record("project settings", path.join(options.cwd, options.configDirName, "settings.json"), PROJECT_SAFE_KEYS);
	}

	return { config, sources, resourcePaths };
}
