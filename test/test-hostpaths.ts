/**
 * Unit tests for the read-only host window.
 *
 * These assert the two halves of the promise: paths that are meant to be
 * readable are, and credentials are not — whatever root is configured, and
 * whichever spelling or symlink is used to ask for them.
 *
 * Needs no container and no pi packages.
 *
 * Usage: node test/test-hostpaths.ts
 */

import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	AGENT_RESOURCE_DIRS,
	createHostReadPolicy,
	isInside,
	piResourceRoots,
	resolveReadableRoots,
} from "../src/hostpaths.ts";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
	try {
		await fn();
		passed++;
		console.log(`  PASS  ${name}`);
	} catch (error) {
		failed++;
		console.log(`  FAIL  ${name}`);
		console.log(`        ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function main(): Promise<void> {
	const root = mkdtempSync(path.join(tmpdir(), "dc-hostpaths-"));
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".pi", "agent");
	const skills = path.join(agentDir, "skills");
	const workspace = path.join(home, "project");

	mkdirSync(path.join(skills, "tuicr"), { recursive: true });
	mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
	mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
	mkdirSync(workspace, { recursive: true });
	writeFileSync(path.join(skills, "tuicr", "SKILL.md"), "# skill\n");
	writeFileSync(path.join(agentDir, "auth.json"), '{"key":"secret"}');
	writeFileSync(path.join(agentDir, "settings.json"), '{"mcpServers":{}}');

	const policy = createHostReadPolicy({ roots: [skills, path.join(agentDir, "extensions")], agentDir });

	console.log("\n--- skills and extensions are readable ---");

	await test("a skill file under the skills directory is readable", () => {
		assert.strictEqual(policy.decide(path.join(skills, "tuicr", "SKILL.md")).verdict, "readable");
	});

	await test("the root itself is readable, so it can be listed", () => {
		assert.strictEqual(policy.decide(skills).verdict, "readable");
	});

	await test("an extension source file is readable", () => {
		assert.strictEqual(policy.decide(path.join(agentDir, "extensions", "thing.ts")).verdict, "readable");
	});

	console.log("\n--- everything else still means the container ---");

	await test("a path outside every root is left to the container", () => {
		for (const candidate of ["/etc/hosts", "/usr/lib/node", path.join(workspace, "src", "a.ts")]) {
			assert.strictEqual(policy.decide(candidate).verdict, "container", candidate);
		}
	});

	await test("a sibling directory with a matching prefix is not inside a root", () => {
		assert.strictEqual(policy.decide(`${skills}-other/x`).verdict, "container");
	});

	await test("traversal out of a root leaves the window entirely", () => {
		// Normalised first, so ".." cannot climb out of a root and stay readable;
		// what it names is then an ordinary container path.
		for (const escape of [`${skills}/../auth.json`, `${skills}/../../../etc/hosts`]) {
			assert.strictEqual(policy.decide(escape).verdict, "container", escape);
		}
	});

	console.log("\n--- pi's own credentials are structurally out of reach ---");

	await test("pi's agent directory is readable only in its resource subdirectories", () => {
		const wide = createHostReadPolicy({ roots: [agentDir], agentDir });
		for (const secret of ["auth.json", "settings.json", "models-store.json", "sessions/2024.jsonl"]) {
			const decision = wide.decide(path.join(agentDir, secret));
			assert.strictEqual(decision.verdict, "denied", secret);
			assert.match(String(decision.reason), /agent directory/);
		}
		assert.strictEqual(wide.decide(path.join(agentDir, "skills", "x", "SKILL.md")).verdict, "readable");
	});

	await test("that holds however wide the roots are, and cannot be configured away", () => {
		const permissive = createHostReadPolicy({ roots: ["/"], agentDir, ignore: ["!auth.json", "!**"] });
		assert.strictEqual(permissive.decide(path.join(agentDir, "auth.json")).verdict, "denied");
		assert.strictEqual(permissive.decide(path.join(agentDir, "sessions", "a.jsonl")).verdict, "denied");
		assert.strictEqual(permissive.decide(path.join(skills, "tuicr", "SKILL.md")).verdict, "readable");
	});

	await test("a root inside the agent directory is dropped rather than honored", () => {
		const sneaky = createHostReadPolicy({ roots: [path.join(agentDir, "sessions")], agentDir });
		assert.deepStrictEqual(sneaky.roots, []);
		assert.strictEqual(sneaky.decide(path.join(agentDir, "sessions", "a.jsonl")).verdict, "container");
	});

	await test("a symlink out of a root cannot launder pi's credentials", () => {
		symlinkSync(path.join(agentDir, "auth.json"), path.join(skills, "innocent.md"));
		const decision = policy.decide(path.join(skills, "innocent.md"));
		assert.strictEqual(decision.verdict, "denied");
		assert.match(String(decision.reason), /agent directory/);
	});

	await test("a symlink to an ordinary file is still readable", () => {
		// Skill directories are commonly symlinks (home-manager, dotfile repos).
		const elsewhere = path.join(root, "store", "skill");
		mkdirSync(elsewhere, { recursive: true });
		writeFileSync(path.join(elsewhere, "SKILL.md"), "# linked\n");
		symlinkSync(elsewhere, path.join(skills, "linked"));
		assert.strictEqual(policy.decide(path.join(skills, "linked", "SKILL.md")).verdict, "readable");
	});

	console.log("\n--- nothing else is denied by guesswork ---");

	await test("a root is the boundary: names are not second-guessed inside it", () => {
		// Adding a root is a decision, and pretending a name filter makes a wide
		// one safe would be the more dangerous design: it is wrong about ordinary
		// files and incomplete about real ones.
		const wide = createHostReadPolicy({ roots: [home], agentDir });
		for (const candidate of [
			path.join(home, "notes", "todo.md"),
			path.join(home, "reference", "generate_secret.d.ts"),
			path.join(home, "reference", "api-keys.md"),
			path.join(home, ".ssh", "id_rsa"),
		]) {
			assert.strictEqual(wide.decide(candidate).verdict, "readable", candidate);
		}
	});

	console.log("\n--- unreadableHostPatterns, gitignore style ---");

	await test("a bare name excludes that component anywhere, and everything under it", () => {
		const guarded = createHostReadPolicy({ roots: [home], agentDir, ignore: [".ssh", "*.pem"] });
		assert.strictEqual(guarded.decide(path.join(home, ".ssh", "id_rsa")).verdict, "denied");
		assert.strictEqual(guarded.decide(path.join(home, "certs", "server.pem")).verdict, "denied");
		assert.strictEqual(guarded.decide(path.join(home, "notes", "todo.md")).verdict, "readable");
	});

	await test("matching is case-insensitive, unlike git", () => {
		const guarded = createHostReadPolicy({ roots: [home], agentDir, ignore: ["id_rsa"] });
		assert.strictEqual(guarded.decide(path.join(home, "keys", "ID_RSA")).verdict, "denied");
	});

	await test("a pattern with a slash matches the path as it reads on disk", () => {
		// No per-root base to work out: it matches the tail of the absolute path.
		const guarded = createHostReadPolicy({ roots: [home], agentDir, ignore: ["work/keys"] });
		assert.strictEqual(guarded.decide(path.join(home, "work", "keys", "a.txt")).verdict, "denied");
		assert.strictEqual(guarded.decide(path.join(home, "nested", "work", "keys", "b.txt")).verdict, "denied");
		assert.strictEqual(guarded.decide(path.join(home, "work", "notes.md")).verdict, "readable");
	});

	await test("a leading / or ~ pins a pattern to one place", () => {
		const guarded = createHostReadPolicy({
			roots: [home],
			agentDir,
			home,
			ignore: ["~/private", `${home}/work/keys`],
		});
		assert.strictEqual(guarded.decide(path.join(home, "private", "x", "y.md")).verdict, "denied");
		assert.strictEqual(guarded.decide(path.join(home, "work", "keys", "a.txt")).verdict, "denied");
		assert.strictEqual(guarded.decide(path.join(home, "nested", "private", "y.md")).verdict, "readable");
	});

	await test("a trailing slash names a directory", () => {
		const guarded = createHostReadPolicy({ roots: [home], agentDir, ignore: ["secrets/"] });
		assert.strictEqual(guarded.decide(path.join(home, "secrets", "prod.yaml")).verdict, "denied");
	});

	await test("last match wins, so ! puts an exception back", () => {
		const guarded = createHostReadPolicy({
			roots: [home],
			agentDir,
			ignore: ["# keep certificates out", "*.pem", "!public.pem"],
		});
		assert.strictEqual(guarded.decide(path.join(home, "certs", "server.pem")).verdict, "denied");
		assert.strictEqual(guarded.decide(path.join(home, "certs", "public.pem")).verdict, "readable");
	});

	await test("order matters, as it does in a .gitignore", () => {
		const putBackFirst = createHostReadPolicy({ roots: [home], agentDir, ignore: ["!public.pem", "*.pem"] });
		assert.strictEqual(putBackFirst.decide(path.join(home, "certs", "public.pem")).verdict, "denied");
	});

	await test("an excluded path is refused with a reason naming the setting", () => {
		const guarded = createHostReadPolicy({ roots: [home], agentDir, ignore: ["*.pem"] });
		assert.match(String(guarded.decide(path.join(home, "a.pem")).reason), /unreadableHostPatterns/);
	});

	await test("a symlink cannot step around an exclusion", () => {
		const hidden = path.join(root, "hidden");
		mkdirSync(hidden, { recursive: true });
		writeFileSync(path.join(hidden, "key.pem"), "secret\n");
		symlinkSync(path.join(hidden, "key.pem"), path.join(home, "innocent.md"));
		const guarded = createHostReadPolicy({ roots: [home, hidden], agentDir, ignore: ["*.pem"] });
		assert.strictEqual(guarded.decide(path.join(home, "innocent.md")).verdict, "denied");
	});

	await test("an excluded root is dropped, not left for each lookup to catch", () => {
		const guarded = createHostReadPolicy({ roots: [path.join(home, "vault"), skills], agentDir, ignore: ["vault"] });
		assert.deepStrictEqual(guarded.roots, [skills]);
	});

	await test("the patterns reach inside pi's own resource directories too", () => {
		// Another extension may keep a config file next to itself, and the window
		// shows extensions by default, so the list has to work there.
		const extensions = path.join(agentDir, "extensions");
		const guarded = createHostReadPolicy({
			roots: [extensions, skills],
			agentDir,
			ignore: ["extensions/*/config.json", "SKILL.md"],
		});
		assert.strictEqual(guarded.decide(path.join(extensions, "other", "config.json")).verdict, "denied");
		assert.strictEqual(guarded.decide(path.join(extensions, "other", "index.ts")).verdict, "readable");
		assert.strictEqual(guarded.decide(path.join(skills, "tuicr", "SKILL.md")).verdict, "denied");
	});

	await test("with several roots under one directory, a pattern still reads as the path does", () => {
		// skills/ and extensions/ are separate roots, so a per-root base would
		// make one list mean two different things. Naming the path avoids that.
		const extensions = path.join(agentDir, "extensions");
		const guarded = createHostReadPolicy({ roots: [extensions, skills], agentDir, ignore: ["skills/tuicr"] });
		assert.strictEqual(guarded.decide(path.join(skills, "tuicr", "SKILL.md")).verdict, "denied");
		assert.strictEqual(guarded.decide(path.join(extensions, "tuicr", "index.ts")).verdict, "readable");
	});

	await test("* matches dot-prefixed names, which most glob engines refuse", () => {
		// The window's own roots live under ~/.pi, and the names people mean to
		// exclude start with a dot, so the usual glob rule would be a silent hole.
		const guarded = createHostReadPolicy({
			roots: [home],
			agentDir,
			ignore: ["*.env", "agent/*/private.json"],
		});
		assert.strictEqual(guarded.decide(path.join(home, "app", ".env")).verdict, "denied");
		assert.strictEqual(guarded.decide(path.join(home, "app", "prod.env")).verdict, "denied");
		assert.strictEqual(guarded.decide(path.join(agentDir, "skills", "private.json")).verdict, "denied");
	});

	await test("a pasted .gitignore block works as it stands", () => {
		// `#` is not how you write a comment in settings.json — that is JSONC, so
		// `//` — but a block pasted from a .gitignore brings its comments along,
		// and turning one into a pattern would be a silent surprise.
		const guarded = createHostReadPolicy({
			roots: [home],
			agentDir,
			ignore: ["# credentials", ".ssh/", "", "   "],
		});
		assert.strictEqual(guarded.decide(path.join(home, ".ssh", "id_rsa")).verdict, "denied");
		assert.strictEqual(guarded.decide(path.join(home, "# credentials")).verdict, "readable");
		assert.strictEqual(guarded.decide(path.join(home, "notes.md")).verdict, "readable");
	});

	await test("the documented example is the behaviour: slashed patterns end at a boundary", () => {
		const target = path.join(agentDir, "extensions", "pi-foo", "config.json");
		const excludes = (entry: string) =>
			createHostReadPolicy({ roots: [agentDir], agentDir, home, ignore: [entry] }).decide(target).verdict ===
			"denied";
		for (const entry of ["config.json", "*.json", "pi-foo/", "extensions/pi-foo/config.json"]) {
			assert.ok(excludes(entry), `${entry} should exclude the file`);
		}
		for (const entry of ["agent/config.json", "foo/config.json", "config", "*.jso"]) {
			assert.ok(!excludes(entry), `${entry} should not exclude the file`);
		}
	});

	await test("an unparseable pattern falls back to a literal name", () => {
		const guarded = createHostReadPolicy({ roots: [home], agentDir, ignore: ["[unclosed"] });
		assert.strictEqual(guarded.decide(path.join(home, "[unclosed")).verdict, "denied");
		assert.strictEqual(guarded.decide(path.join(home, "ordinary.md")).verdict, "readable");
	});

	await test("matching stays linear on patterns that would trap a regular expression", () => {
		// Every routed read, ls, find and grep asks this question, so a pattern
		// list must not be a place where a long path costs milliseconds. Several
		// `**` compiled into one regular expression is the classic way to get that
		// wrong; the segment walk never explores the same split twice.
		const nasty = createHostReadPolicy({
			roots: [home],
			agentDir,
			ignore: ["**/a/**/b/**/c/**/d/**/e.json", "**/*/*/*/*/*/*/*.pem"],
			resolve: (candidate) => candidate,
		});
		const long = path.join(home, ...Array.from({ length: 60 }, (_, index) => `segment-number-${index}`), "a", "f.txt");
		assert.strictEqual(nasty.decide(long).verdict, "readable");

		const started = process.hrtime.bigint();
		for (let index = 0; index < 1000; index++) nasty.decide(long);
		const perCall = Number(process.hrtime.bigint() - started) / 1000 / 1_000_000;
		assert.ok(perCall < 1, `${perCall.toFixed(3)}ms per decision is too slow for a per-tool-call check`);
	});

	console.log("\n--- roots are resolved the way settings spell them ---");

	await test('"~" is expanded and relative entries resolve against the session directory', () => {
		const { roots } = resolveReadableRoots(["~/reference", "./local", "/opt/docs"], { home, cwd: workspace });
		assert.deepStrictEqual(roots, [
			path.join(home, "reference"),
			path.join(workspace, "local"),
			"/opt/docs",
		]);
	});

	await test("paths inside the workspace are skipped, since the container has them", () => {
		const { roots, skipped } = resolveReadableRoots([path.join(workspace, "docs"), "/opt/docs"], {
			home,
			cwd: workspace,
			hostWorkspace: workspace,
		});
		assert.deepStrictEqual(roots, ["/opt/docs"]);
		assert.strictEqual(skipped.length, 1);
		assert.match(skipped[0].reason, /workspace/);
	});

	await test("duplicates collapse", () => {
		const { roots } = resolveReadableRoots(["/opt/docs", "/opt/docs/", "/opt/docs/."], { home, cwd: workspace });
		assert.deepStrictEqual(roots, ["/opt/docs"]);
	});

	console.log("\n--- pi's own resource locations ---");

	await test("the defaults cover skills, extensions and installed packages", () => {
		const roots = piResourceRoots({ agentDir, home, skillDirs: ["/nix/store/abc/skills/x"], extra: ["/pi/docs"] });
		for (const name of AGENT_RESOURCE_DIRS) {
			assert.ok(roots.includes(path.join(agentDir, name)), `missing ${name}`);
		}
		assert.ok(roots.includes(path.join(home, ".agents", "skills")), "the shared agent skills directory");
		assert.ok(roots.includes("/nix/store/abc/skills/x"), "a skill directory pi actually loaded");
		assert.ok(roots.includes("/pi/docs"));
	});

	await test("npm and git package directories are covered, so packaged skills load", () => {
		const roots = piResourceRoots({ agentDir, home });
		assert.ok(roots.includes(path.join(agentDir, "npm")));
		assert.ok(roots.includes(path.join(agentDir, "git")));
	});

	await test("isInside is exact about containment", () => {
		assert.ok(isInside("/a/b", "/a/b"));
		assert.ok(isInside("/a/b", "/a/b/c"));
		assert.ok(!isInside("/a/b", "/a/bc"));
		assert.ok(!isInside("/a/b", "/a"));
	});

	rmSync(root, { recursive: true, force: true });

	console.log(`\n${failed === 0 ? "ALL TESTS PASSED" : "SOME TESTS FAILED"}: ${passed} passed, ${failed} failed\n`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
