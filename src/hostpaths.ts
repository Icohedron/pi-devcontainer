/**
 * Which host paths a routed session may read.
 *
 * Routing sends every path into the container, which is the point: an absolute
 * path means the container's copy. But some things the agent is *told about*
 * only exist on the host — pi's own skills and extensions are named in the
 * system prompt by absolute host path, and inside the container those paths do
 * not exist. Reading them is how a skill is used at all.
 *
 * So a narrow window is opened back to the host, with three properties:
 *
 *   1. **Read-only.** Only `read`, `ls`, `find` and `grep` may look through it.
 *      `write`, `edit` and `bash` never reach the host filesystem, so nothing
 *      the agent does can change what is on the other side of it.
 *   2. **Enumerated.** Only paths under a configured root are visible. Anything
 *      else keeps meaning the container's copy, exactly as before.
 *   3. **pi's own credentials are structurally out of reach.** Its agent
 *      directory is readable only in the subdirectories that hold skills,
 *      extensions and packages, so `auth.json`, `settings.json` (MCP servers
 *      carry keys), `models-store.json` and the session transcripts beside them
 *      are never behind the window, at any root and under any configuration.
 *
 * That last rule is the only thing this module denies on its own. It is not a
 * guess: these are pi's own files, in a fixed layout, and it is the one place
 * this extension can be certain about. Everything else is the user's to state,
 * as a gitignore-style list, because a built-in list of "names that look like
 * secrets" would be both wrong (`generate_secret.d.ts` is library code, and
 * npm packages ship such names) and incomplete (a key can be in a file called
 * anything), and an incomplete filter invites trusting a root that should not
 * have been added in the first place.
 *
 * Symlinks are checked on both sides: a link inside a root is resolved and the
 * rules are applied to the destination too, so a skill directory cannot be
 * used as a pointer into pi's agent directory.
 *
 * Pure functions and fs lookups only; no pi imports, so this stays testable
 * without pi's packages installed.
 */

import { realpathSync } from "node:fs";
import path from "node:path";

/** What a routed tool should do with a path. */
export type HostPathVerdict =
	/** Not on the host window: means the container's copy, as always. */
	| "container"
	/** Under a readable root: serve it from the host, read-only. */
	| "readable"
	/** Under a readable root but denied: refuse, and say why. */
	| "denied";

export interface HostPathDecision {
	verdict: HostPathVerdict;
	/** Present when the verdict is "denied". */
	reason?: string;
}

/**
 * Subdirectories of pi's agent directory that hold skills, extensions and the
 * packages carrying them. Everything else in there — auth.json, settings.json,
 * models-store.json, sessions/, .cache/ — is credentials or transcripts.
 */
export const AGENT_RESOURCE_DIRS = ["skills", "extensions", "npm", "git", "prompts", "themes", "tools"];

/** True when candidate is root itself or lives underneath it. */
export function isInside(root: string, candidate: string): boolean {
	// A prefix comparison, not path.relative: both sides are already absolute
	// and normalised, and this runs for every root on every routed tool call.
	if (!candidate.startsWith(root)) return false;
	if (candidate.length === root.length) return true;
	const next = candidate[root.length];
	const last = root[root.length - 1];
	return next === "/" || next === "\\" || last === "/" || last === "\\";
}

/** Resolve symlinks as far as the filesystem allows; the path itself otherwise. */
function resolveLinks(absolutePath: string): string {
	try {
		return realpathSync(absolutePath);
	} catch {
		return absolutePath;
	}
}

/**
 * One component of a pattern: `**`, a plain name, or a wildcard to compile.
 *
 * Plain names are the overwhelming majority (`id_rsa`, `.ssh`, `secrets`) and
 * are compared as strings, so most entries never touch a regular expression.
 */
interface SegmentMatcher {
	doubleStar?: true;
	literal?: string;
	regex?: RegExp;
}

/**
 * Compile one pattern component.
 *
 * Wildcards become a regular expression over a single component, so it can
 * contain no `/` and cannot backtrack across the path. Node's
 * `path.matchesGlob` is not usable here: like most glob implementations it
 * refuses to let `*` match a dot-prefixed name, so `*.env` would not match
 * `.env`, and nothing under `~/.pi` would match at all. For an exclusion list
 * that is exactly backwards — the dot-prefixed names are the ones people mean.
 */
function compileSegment(segment: string): SegmentMatcher {
	if (segment === "**") return { doubleStar: true };
	if (!/[*?[]/.test(segment)) return { literal: segment };

	let source = "";
	for (let index = 0; index < segment.length; index++) {
		const char = segment[index];
		if (char === "*") {
			source += "[^/]*";
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			continue;
		}
		if (char === "[") {
			const close = segment.indexOf("]", index + 1);
			if (close === -1) {
				// Unterminated: a literal bracket, so a typo cannot widen the window.
				source += "\\[";
				continue;
			}
			const body = segment.slice(index + 1, close).replace(/\\/g, "\\\\");
			source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
			index = close;
			continue;
		}
		source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return { regex: new RegExp(`^${source}$`) };
}

function segmentMatches(matcher: SegmentMatcher, component: string): boolean {
	if (matcher.literal !== undefined) return matcher.literal === component;
	return matcher.regex?.test(component) ?? true;
}

/**
 * Match path components against pattern components.
 *
 * The standard two-pointer wildcard walk, with one remembered `**` to fall
 * back to. It is linear in the path and never explores a split twice, unlike a
 * regular expression built from several `.*` groups, which can take most of a
 * millisecond on a long path that does not match.
 */
function matchSegments(pattern: readonly SegmentMatcher[], components: readonly string[]): boolean {
	let patternIndex = 0;
	let componentIndex = 0;
	let starIndex = -1;
	let starComponent = 0;

	while (componentIndex < components.length) {
		const matcher = pattern[patternIndex];
		if (matcher?.doubleStar) {
			starIndex = patternIndex++;
			starComponent = componentIndex;
			continue;
		}
		if (matcher && segmentMatches(matcher, components[componentIndex])) {
			patternIndex++;
			componentIndex++;
			continue;
		}
		if (starIndex === -1) return false;
		// Let the remembered ** swallow one more component and try again.
		patternIndex = starIndex + 1;
		componentIndex = ++starComponent;
	}

	while (pattern[patternIndex]?.doubleStar) patternIndex++;
	return patternIndex === pattern.length;
}

/** One parsed entry of the gitignore-style list. */
interface IgnorePattern {
	/** `!pattern`: put back what an earlier entry took away. */
	negated: boolean;
	/** Set for a pattern with no slash: matched against any single component. */
	component?: SegmentMatcher;
	/** Set for a pattern with a slash: matched against the whole path. */
	segments?: SegmentMatcher[];
}

/**
 * Parse gitignore syntax: `#` comments, `!` negation, `dir/`, and slashes.
 *
 * Two deliberate differences from git, both because there is no repository
 * here to be relative to:
 *
 *   - A pattern containing a slash is matched against the **absolute path**,
 *     from the end, so `extensions/pi-foo/config.json` matches wherever that
 *     is on disk. Begin it with `/` or `~/` to pin it exactly. Matching from a
 *     root instead would raise a question with no good answer: the readable
 *     roots inside pi's agent directory are `skills`, `extensions`, `npm` and
 *     the rest individually, so `extensions/x` would have to be written `x`,
 *     and one list would mean different things under different roots.
 *   - Matching is case-insensitive. These entries name things the user wants
 *     kept out, and a rule that stops working because a file is called
 *     `ID_RSA` would be a poor trade for consistency with a tool that is not
 *     involved here.
 *
 * A pattern with no slash matches any single component, at any depth, which is
 * the same as git and is what most entries are.
 */
export function parseIgnoreList(entries: readonly string[], home?: string): IgnorePattern[] {
	const patterns: IgnorePattern[] = [];
	for (const entry of entries) {
		let glob = entry.trim();
		if (!glob || glob.startsWith("#")) continue;
		const negated = glob.startsWith("!");
		if (negated) glob = glob.slice(1).trim();
		// A trailing slash means a directory; the trailing ** added below
		// already covers everything under whatever matched.
		glob = glob.replace(/\/+$/, "").toLowerCase();
		if (!glob) continue;

		if (!glob.includes("/")) {
			patterns.push({ negated, component: compileSegment(glob) });
			continue;
		}

		if (home && (glob === "~" || glob.startsWith("~/"))) {
			glob = path.posix.join(home.toLowerCase(), glob.slice(1));
		}
		const pinned = glob.startsWith("/");
		const anyDepth = { doubleStar: true } as const;
		// "." components are dropped, so "./secrets" and "secrets" agree. Paths are
		// resolved before they are compared, and never contain one.
		const parts = glob.split("/").filter((part) => part && part !== ".");
		if (parts.length === 0) continue;
		patterns.push({
			negated,
			segments: [
				// Not pinned: match the tail of the path. Trailing **: whatever
				// matched covers what is under it, as a directory entry does in a
				// .gitignore.
				...(pinned ? [] : [anyDepth]),
				...parts.map(compileSegment),
				anyDepth,
			],
		});
	}
	return patterns;
}

/**
 * Apply the list to one absolute path. Last match wins, as git does it.
 *
 * Returns true for denied, false for explicitly put back, and undefined when
 * no entry has an opinion.
 */
export function ignoreVerdict(absolutePath: string, patterns: readonly IgnorePattern[]): boolean | undefined {
	if (patterns.length === 0) return undefined;
	// Split and lowercase once, rather than once per pattern.
	const components = absolutePath.toLowerCase().split(/[\\/]+/).filter(Boolean);

	let verdict: boolean | undefined;
	for (const pattern of patterns) {
		const component = pattern.component;
		const matched = component
			? components.some((entry) => segmentMatches(component, entry))
			: matchSegments(pattern.segments as SegmentMatcher[], components);
		if (matched) verdict = !pattern.negated;
	}
	return verdict;
}

/**
 * Reject a path that sits in pi's agent directory outside its resource
 * subdirectories. Applied to the path as written and to its symlink
 * destination, so neither spelling reaches auth.json.
 */
function agentDirDenial(agentDir: string | undefined, candidate: string): string | undefined {
	if (!agentDir || !isInside(agentDir, candidate)) return undefined;
	if (candidate.length === agentDir.length) return undefined; // The directory itself lists fine.
	// The first component below the agent directory decides, so take it directly
	// rather than paying for path.relative on every lookup.
	const rest = candidate.slice(agentDir.length + 1);
	const end = rest.search(/[\\/]/);
	const first = end === -1 ? rest : rest.slice(0, end);
	if (AGENT_RESOURCE_DIRS.includes(first)) return undefined;
	return (
		`${candidate} is inside pi's agent directory, which is readable only in ` +
		`${AGENT_RESOURCE_DIRS.join(", ")}; the rest holds credentials and session data`
	);
}

export interface HostReadPolicyOptions {
	/** Roots whose contents may be read from the host. */
	roots: string[];
	/** pi's agent directory, readable only in AGENT_RESOURCE_DIRS. */
	agentDir?: string;
	/** gitignore-style patterns for paths that must stay unreadable. */
	ignore?: readonly string[];
	/** Home directory, so a pattern may be written with "~". */
	home?: string;
	/** Test seam for symlink resolution. */
	resolve?: (absolutePath: string) => string;
}

export interface HostReadPolicy {
	/** Roots in effect, absolute and deduplicated. */
	readonly roots: string[];
	/** Decide what a routed tool should do with an absolute path. */
	decide(absolutePath: string): HostPathDecision;
}

/** Build the read-only host window. */
export function createHostReadPolicy(options: HostReadPolicyOptions): HostReadPolicy {
	const resolve = options.resolve ?? resolveLinks;
	const agentDir = options.agentDir ? path.resolve(options.agentDir) : undefined;
	const patterns = parseIgnoreList(options.ignore ?? [], options.home);

	// A root that is itself excluded would be a hole in the rules, so drop it
	// rather than trusting every lookup underneath it to notice.
	const permitted = dedupe(options.roots.map((root) => path.resolve(root))).filter(
		(root) => !agentDirDenial(agentDir, root) && ignoreVerdict(root, patterns) !== true,
	);

	// A root inside another root grants nothing, and pi hands over the directory
	// of every skill it loaded: with the usual layout each one sits under
	// <agent dir>/skills or <agent dir>/npm already. Dropping them keeps the
	// list short enough to show in full, and keeps every lookup shorter.
	const roots = permitted.filter((root) => !permitted.some((other) => other !== root && isInside(other, root)));

	return {
		roots,
		decide(absolutePath: string): HostPathDecision {
			const candidate = path.resolve(absolutePath);
			if (!roots.some((root) => isInside(root, candidate))) return { verdict: "container" };

			// The path as asked for, and where it actually leads. Checking both is
			// what stops a symlink inside a root from pointing somewhere excluded.
			const resolved = resolve(candidate);
			for (const form of resolved === candidate ? [candidate] : [candidate, resolved]) {
				// Structural, and deliberately not overridable: no entry in the
				// list, however permissive, opens pi's own credentials.
				const denial = agentDirDenial(agentDir, form);
				if (denial) return { verdict: "denied", reason: denial };

				if (ignoreVerdict(form, patterns) === true) {
					return {
						verdict: "denied",
						reason: `${form} is excluded by unreadableHostPatterns`,
					};
				}
			}

			return { verdict: "readable" };
		},
	};
}

function dedupe(values: string[]): string[] {
	return [...new Set(values)];
}

export interface ResolveRootsOptions {
	/** Home directory, for "~" entries. */
	home: string;
	/** Directory relative entries resolve against. */
	cwd: string;
	/** Host workspace; roots inside it are dropped, being routed already. */
	hostWorkspace?: string;
}

export interface ResolvedRoots {
	roots: string[];
	skipped: Array<{ path: string; reason: string }>;
}

/**
 * Turn configured entries into absolute roots.
 *
 * Paths inside the workspace are dropped: they are bind-mounted into the
 * container, so the container already sees the same files, and reading them on
 * the host instead would only bypass the routing that is the point of this
 * extension. It matters for more than tidiness — the workspace is the one place
 * the agent can create files, so keeping it out of the window keeps the agent
 * from planting a symlink into it.
 */
export function resolveReadableRoots(entries: readonly string[], options: ResolveRootsOptions): ResolvedRoots {
	const roots: string[] = [];
	const skipped: Array<{ path: string; reason: string }> = [];

	for (const entry of entries) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const expanded =
			trimmed === "~" ? options.home : trimmed.startsWith("~/") ? path.join(options.home, trimmed.slice(2)) : trimmed;
		const absolute = path.resolve(options.cwd, expanded);
		if (options.hostWorkspace && isInside(options.hostWorkspace, absolute)) {
			skipped.push({ path: absolute, reason: "inside the workspace, which the container already sees" });
			continue;
		}
		roots.push(absolute);
	}

	return { roots: dedupe(roots), skipped };
}

/**
 * The host paths pi's own skills and extensions live in.
 *
 * `skillDirs` comes from the skills pi actually loaded, so directories chosen
 * by settings, a package, `--skill`, or another harness are covered without
 * this module having to know pi's discovery rules.
 */
export function piResourceRoots(options: {
	agentDir: string;
	home: string;
	/** Directories of loaded skills. */
	skillDirs?: readonly string[];
	/** Extra pi-owned paths, such as its docs and examples. */
	extra?: readonly string[];
}): string[] {
	const agent = options.agentDir;
	return dedupe([
		...AGENT_RESOURCE_DIRS.map((name) => path.join(agent, name)),
		path.join(options.home, ".agents", "skills"),
		...(options.skillDirs ?? []),
		...(options.extra ?? []),
	]);
}
