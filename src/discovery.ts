/**
 * Devcontainer configuration discovery.
 *
 * Walks up from the working directory and returns the first devcontainer
 * configuration found.
 *
 * The devcontainer CLI auto-discovers exactly two locations:
 * .devcontainer/devcontainer.json and .devcontainer.json. A
 * .devcontainer/<folder>/devcontainer.json layout is a VS Code convenience for
 * repositories with several configurations; the CLI only reads those when given
 * --config, which is why devcontainerUp() passes the discovered path.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface DevcontainerConfig {
	/** Absolute path to the discovered devcontainer.json */
	configPath: string;
	/** Directory containing the config (the devcontainer "local folder") */
	workspaceFolder: string;
	/** Parsed config contents, when readable */
	config: DevcontainerJson;
}

export interface DevcontainerJson {
	name?: string;
	remoteUser?: string;
	containerUser?: string;
	workspaceFolder?: string;
	[key: string]: unknown;
}

/**
 * Strip comments and trailing commas so JSONC configs parse with JSON.parse.
 * Quoted strings are preserved verbatim.
 */
export function parseJsonc(text: string): DevcontainerJson {
	let out = "";
	let inString = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		const next = text[i + 1];

		if (inLineComment) {
			if (char === "\n") {
				inLineComment = false;
				out += char;
			}
			continue;
		}
		if (inBlockComment) {
			if (char === "*" && next === "/") {
				inBlockComment = false;
				i++;
			}
			continue;
		}
		if (inString) {
			out += char;
			if (char === "\\") {
				out += next ?? "";
				i++;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			out += char;
			continue;
		}
		if (char === "/" && next === "/") {
			inLineComment = true;
			i++;
			continue;
		}
		if (char === "/" && next === "*") {
			inBlockComment = true;
			i++;
			continue;
		}
		out += char;
	}

	// Remove trailing commas before } or ]
	out = out.replace(/,(\s*[}\]])/g, "$1");
	const parsed = JSON.parse(out);
	return parsed && typeof parsed === "object" ? (parsed as DevcontainerJson) : {};
}

function readConfig(configPath: string): DevcontainerJson {
	try {
		return parseJsonc(readFileSync(configPath, "utf8"));
	} catch {
		return {};
	}
}

/** Candidate config paths within a single directory, most standard first. */
function candidatesIn(dir: string): string[] {
	const candidates = [path.join(dir, ".devcontainer", "devcontainer.json"), path.join(dir, ".devcontainer.json")];

	// VS Code multi-configuration layout, checked only after the two locations
	// the CLI itself discovers.
	const devcontainerDir = path.join(dir, ".devcontainer");
	try {
		if (statSync(devcontainerDir).isDirectory()) {
			const subdirs = readdirSync(devcontainerDir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort();
			for (const sub of subdirs) {
				candidates.push(path.join(devcontainerDir, sub, "devcontainer.json"));
			}
		}
	} catch {
		// No .devcontainer directory here.
	}

	return candidates;
}

/**
 * Find the nearest devcontainer config, searching startDir and then each
 * parent directory. Returns the first match found while walking upward.
 */
export function findDevcontainerConfig(startDir: string): DevcontainerConfig | null {
	let dir = path.resolve(startDir);

	for (;;) {
		for (const candidate of candidatesIn(dir)) {
			if (existsSync(candidate)) {
				return { configPath: candidate, workspaceFolder: dir, config: readConfig(candidate) };
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}
