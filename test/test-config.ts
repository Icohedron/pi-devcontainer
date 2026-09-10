/**
 * Settings merging tests, plus proof that a configured custom runtime binary
 * and extra args are actually used for container calls.
 *
 * Settings are read from pi's settings.json files under a "devcontainer" key.
 *
 * The container part needs a running devcontainer; the merge tests do not.
 *
 * Usage: node test/test-config.ts
 */

import assert from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	containerExec,
	detectRuntimes,
	devcontainerUp,
	findRunningContainer,
	isContainerGoneError,
} from "../src/container.ts";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
import { findDevcontainerConfig } from "../src/discovery.ts";

const REPO = path.resolve(import.meta.dirname, "..");

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

/** Fake home/project trees so pi's settings files can be exercised in isolation. */
function scaffold(): {
	home: string;
	project: string;
	writeUser: (settings: unknown) => void;
	writeProject: (settings: unknown) => void;
	cleanup: () => void;
} {
	const root = mkdtempSync(path.join(tmpdir(), "dc-settings-"));
	const home = path.join(root, "home");
	const project = path.join(root, "project");
	mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	mkdirSync(path.join(project, ".pi"), { recursive: true });
	const userFile = path.join(home, ".pi", "agent", "settings.json");
	const projectFile = path.join(project, ".pi", "settings.json");
	return {
		home,
		project,
		writeUser: (settings) => writeFileSync(userFile, typeof settings === "string" ? settings : JSON.stringify(settings)),
		writeProject: (settings) =>
			writeFileSync(projectFile, typeof settings === "string" ? settings : JSON.stringify(settings)),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

async function main(): Promise<void> {
	console.log("\n--- config defaults ---");

	await test("defaults apply when nothing is configured", () => {
		const { home, project, writeUser, writeProject, cleanup } = scaffold();
		try {
			const { config, sources } = loadConfig({ configDirName: ".pi", cwd: project, trusted: true, home });
			assert.deepStrictEqual(config, DEFAULT_CONFIG);
			assert.deepStrictEqual(sources, []);
		} finally {
			cleanup();
		}
	});

	console.log("\n--- config sources ---");

	await test("reads the user config file", () => {
		const { home, project, writeUser, cleanup } = scaffold();
		try {
			writeUser({
				defaultModel: "some-model",
				devcontainer: { runtime: "/usr/local/bin/docker", upArgs: ["--docker-path", "/usr/local/bin/docker"] },
			});
			const { config, sources } = loadConfig({ configDirName: ".pi", cwd: project, trusted: true, home });
			assert.strictEqual(config.runtime, "/usr/local/bin/docker");
			assert.deepStrictEqual(config.upArgs, ["--docker-path", "/usr/local/bin/docker"]);
			assert.strictEqual(sources[0]?.label, "user settings");
		} finally {
			cleanup();
		}
	});

	await test("ignores the rest of settings.json", () => {
		const { home, project, writeUser, cleanup } = scaffold();
		try {
			writeUser({
				defaultProvider: "anthropic",
				packages: ["npm:something"],
				someOtherExtension: { enabled: true },
				devcontainer: { runtime: "podman", execArgs: ["--env", "A=1"] },
			});
			const { config } = loadConfig({ configDirName: ".pi", cwd: project, trusted: true, home });
			assert.strictEqual(config.runtime, "podman");
			assert.deepStrictEqual(config.execArgs, ["--env", "A=1"]);
		} finally {
			cleanup();
		}
	});

	await test("no devcontainer key means defaults and no recorded source", () => {
		const { home, project, writeUser, cleanup } = scaffold();
		try {
			writeUser({ defaultModel: "some-model" });
			const { config, sources } = loadConfig({ configDirName: ".pi", cwd: project, trusted: true, home });
			assert.deepStrictEqual(config, DEFAULT_CONFIG);
			assert.deepStrictEqual(sources, []);
		} finally {
			cleanup();
		}
	});

	await test("project settings layer over user settings for project-safe keys", () => {
		const { home, project, writeUser, writeProject, cleanup } = scaffold();
		try {
			writeUser({ devcontainer: { enabled: true, runtime: "from-user", execArgs: ["--env", "KEEP=1"] } });
			writeProject({ devcontainer: { enabled: false } });
			const { config, sources } = loadConfig({ configDirName: ".pi", cwd: project, trusted: true, home });
			assert.strictEqual(config.enabled, false, "project may turn routing off");
			assert.strictEqual(config.runtime, "from-user", "unset keys keep the user value");
			assert.deepStrictEqual(config.execArgs, ["--env", "KEEP=1"]);
			assert.deepStrictEqual(
				sources.map((entry) => entry.label),
				["user settings", "project settings"],
			);
		} finally {
			cleanup();
		}
	});

	await test("project settings are ignored when the project is untrusted", () => {
		const { home, project, writeUser, writeProject, cleanup } = scaffold();
		try {
			writeUser({ devcontainer: { runtime: "from-user" } });
			writeProject({ devcontainer: { runtime: "evil" } });
			const { config } = loadConfig({ configDirName: ".pi", cwd: project, trusted: false, home });
			assert.strictEqual(config.runtime, "from-user", "untrusted project settings must not select a binary");
		} finally {
			cleanup();
		}
	});

	await test("parses JSONC config with comments", () => {
		const { home, project, writeUser, cleanup } = scaffold();
		try {
			writeUser('{\n  "devcontainer": {\n    // pick podman explicitly\n    "runtime": "podman",\n  },\n}');
			const { config } = loadConfig({ configDirName: ".pi", cwd: project, trusted: true, home });
			assert.strictEqual(config.runtime, "podman");
		} finally {
			cleanup();
		}
	});

	await test("ignores malformed values and unknown keys", () => {
		const { home, project, writeUser, cleanup } = scaffold();
		try {
			writeUser({ devcontainer: { runtime: 42, upArgs: "not-an-array", nonsense: true } });
			const { config, sources } = loadConfig({ configDirName: ".pi", cwd: project, trusted: true, home });
			assert.strictEqual(config.runtime, undefined);
			assert.deepStrictEqual(config.upArgs, []);
			assert.deepStrictEqual(sources[0]?.applied, [], "no keys should have applied");
		} finally {
			cleanup();
		}
	});

	await test("enabled:false is carried through", () => {
		const { home, project, writeUser, cleanup } = scaffold();
		try {
			writeUser({ devcontainer: { enabled: false } });
			const { config } = loadConfig({ configDirName: ".pi", cwd: project, trusted: true, home });
			assert.strictEqual(config.enabled, false);
		} finally {
			cleanup();
		}
	});

	console.log("\n--- configured runtime is actually used ---");

	const devcontainer = findDevcontainerConfig(REPO);
	const realRuntimes = devcontainer ? await detectRuntimes() : [];
	const realTarget =
		devcontainer && realRuntimes.length > 0 ? await findRunningContainer(realRuntimes, devcontainer) : null;

	if (!realTarget) {
		console.log("  SKIP  no running devcontainer; runtime wiring tests need one");
	} else {
		const shimDir = mkdtempSync(path.join(tmpdir(), "dc-shim-"));
		const logFile = path.join(shimDir, "calls.log");
		const shim = path.join(shimDir, "my-container-cli");
		writeFileSync(
			shim,
			`#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(logFile)}\nexec ${realTarget.runtime.bin} "$@"\n`,
		);
		chmodSync(shim, 0o755);
		writeFileSync(logFile, "");

		await test("a configured custom runtime binary is used for discovery", async () => {
			const runtimes = await detectRuntimes({ ...DEFAULT_CONFIG, runtime: shim });
			assert.strictEqual(runtimes.length, 1);
			assert.strictEqual(runtimes[0].bin, shim);
			const target = await findRunningContainer(runtimes, devcontainer!);
			assert.ok(target, "custom binary should still find the container");
			assert.strictEqual(target.name, realTarget.name);
			assert.match(readFileSync(logFile, "utf8"), /ps --no-trunc --filter/);
		});

		await test("configured runtimeArgs and execArgs reach the command line", async () => {
			writeFileSync(logFile, "");
			const runtimes = await detectRuntimes({
				...DEFAULT_CONFIG,
				runtime: shim,
				runtimeArgs: ["--log-level", "error"],
				execArgs: ["--env", "PI_DC_TEST=1"],
			});
			const target = await findRunningContainer(runtimes, devcontainer!);
			assert.ok(target);
			const result = await containerExec(target, ["sh", "-c", "printf %s \"$PI_DC_TEST\""]);
			const log = readFileSync(logFile, "utf8");
			assert.match(log, /--log-level error ps /, "global args must precede the subcommand");
			assert.match(log, /--log-level error exec .*--env PI_DC_TEST=1/, "exec args must be applied");
			assert.strictEqual(result.stdout.toString(), "1", "env var from execArgs should reach the container");
		});

		rmSync(shimDir, { recursive: true, force: true });
	}

	console.log("\n--- devcontainer CLI invocation ---");

	await test("devcontainerPath and upArgs reach the devcontainer command line", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "dc-cli-"));
		const log = path.join(dir, "argv.log");
		const shim = path.join(dir, "fake-devcontainer");
		writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(log)}\nexit 0\n`);
		chmodSync(shim, 0o755);
		try {
			const result = await devcontainerUp("/some/workspace", {
				...DEFAULT_CONFIG,
				devcontainerPath: shim,
				upArgs: ["--docker-path", "/usr/local/bin/docker"],
			});
			assert.ok(result.ok, "configured CLI should be invoked and succeed");
			assert.strictEqual(
				readFileSync(log, "utf8").trim(),
				"up --workspace-folder /some/workspace --docker-path /usr/local/bin/docker",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	await test("up passes --config so a subfolder layout starts the right container", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "dc-cli-"));
		const log = path.join(dir, "argv.log");
		const shim = path.join(dir, "fake-devcontainer");
		writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(log)}\nexit 0\n`);
		chmodSync(shim, 0o755);
		try {
			await devcontainerUp(
				"/some/workspace",
				{ ...DEFAULT_CONFIG, devcontainerPath: shim },
				undefined,
				"/some/workspace/.devcontainer/gpu/devcontainer.json",
			);
			assert.strictEqual(
				readFileSync(log, "utf8").trim(),
				"up --workspace-folder /some/workspace --config /some/workspace/.devcontainer/gpu/devcontainer.json",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	await test("a --config in upArgs is not duplicated", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "dc-cli-"));
		const log = path.join(dir, "argv.log");
		const shim = path.join(dir, "fake-devcontainer");
		writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(log)}\nexit 0\n`);
		chmodSync(shim, 0o755);
		try {
			await devcontainerUp(
				"/some/workspace",
				{ ...DEFAULT_CONFIG, devcontainerPath: shim, upArgs: ["--config", "/custom.json"] },
				undefined,
				"/some/workspace/.devcontainer/devcontainer.json",
			);
			const argv = readFileSync(log, "utf8").trim();
			assert.strictEqual(argv.match(/--config/g)?.length, 1, argv);
			assert.match(argv, /--config \/custom\.json/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	await test("userBash defaults to the container and accepts host", () => {
		const { home, project, writeUser, cleanup } = scaffold();
		try {
			assert.strictEqual(
				loadConfig({ configDirName: ".pi", cwd: project, trusted: true, home }).config.userBash,
				"container",
			);
			writeUser({ devcontainer: { userBash: "host" } });
			assert.strictEqual(
				loadConfig({ configDirName: ".pi", cwd: project, trusted: true, home }).config.userBash,
				"host",
			);
		} finally {
			cleanup();
		}
	});

	await test("an invalid userBash value is refused, keeping the safe default", () => {
		const { home, project, writeUser, cleanup } = scaffold();
		try {
			writeUser({ devcontainer: { userBash: "somewhere-else" } });
			const { config } = loadConfig({ configDirName: ".pi", cwd: project, trusted: true, home });
			assert.strictEqual(config.userBash, "container");
		} finally {
			cleanup();
		}
	});

	console.log("\n--- robustness ---");

	await test("up returns when the CLI exits, even if it leaves a child holding stdout", async () => {
		// The reported stall: the log showed the container started, then nothing.
		// Container tooling routinely leaves processes that inherit the pipes, so
		// waiting for stdio to close can wait forever after the command is done.
		const dir = mkdtempSync(path.join(tmpdir(), "dc-stall-"));
		const shim = path.join(dir, "fake-devcontainer");
		writeFileSync(shim, "#!/bin/sh\necho '{\"outcome\":\"success\"}'\nsleep 30 &\nexit 0\n");
		chmodSync(shim, 0o755);
		try {
			const started = Date.now();
			const result = await devcontainerUp("/tmp", { ...DEFAULT_CONFIG, devcontainerPath: shim });
			const elapsed = Date.now() - started;
			assert.ok(result.ok, "the command succeeded, so up must report success");
			assert.ok(elapsed < 10_000, `up took ${elapsed}ms; it must not wait on a lingering child`);
			assert.match(result.output, /outcome/, "output produced before exiting must still be captured");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	await test("an unresponsive container CLI cannot hang detection", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "dc-hang-"));
		const hang = path.join(dir, "hangdocker");
		writeFileSync(hang, "#!/bin/sh\nsleep 600\n");
		chmodSync(hang, 0o755);
		try {
			const started = Date.now();
			const runtimes = await detectRuntimes({ ...DEFAULT_CONFIG, runtime: hang });
			const elapsed = Date.now() - started;
			assert.deepStrictEqual(runtimes, [], "a CLI that never answers must not count as available");
			assert.ok(elapsed < 60_000, `detection took ${elapsed}ms; it must be bounded`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	await test("a container that went away is recognised, ordinary failures are not", () => {
		for (const message of [
			"can only create exec sessions on running containers: container state improper",
			"Error: No such container: abc123",
			"Error response from daemon: Container abc is not running",
		]) {
			assert.strictEqual(isContainerGoneError(new Error(message)), true, message);
		}
		for (const message of ["grep: no such file or directory", "bash: line 1: foo: command not found"]) {
			assert.strictEqual(isContainerGoneError(new Error(message)), false, message);
		}
	});

	console.log("\n--- runtime fallback ---");

	// Needs a real container to fall through to, so it is skipped wherever the
	// runtime wiring tests above were: in-container runs have no docker/podman.
	if (!realTarget) {
		console.log("  SKIP  no running devcontainer; the fallback test needs one");
	} else {
		await test("finds the container even when another runtime answers first but has none", async () => {
			// Simulate docker installed alongside podman, managing no containers.
			const dir = mkdtempSync(path.join(tmpdir(), "dc-fakedocker-"));
			const fake = path.join(dir, "docker");
			writeFileSync(fake, "#!/bin/sh\ncase \"$1\" in ps) exit 0 ;; *) exit 1 ;; esac\n");
			chmodSync(fake, 0o755);
			const originalPath = process.env.PATH;
			process.env.PATH = `${dir}:${originalPath}`;
			try {
				const runtimes = await detectRuntimes();
				assert.ok(
					runtimes.some((r) => r.bin === "docker") && runtimes.some((r) => r.bin === "podman"),
					`expected both runtimes to be probed, got ${runtimes.map((r) => r.bin).join(", ")}`,
				);
				const target = await findRunningContainer(runtimes, devcontainer!);
				assert.ok(target, "must fall through to the runtime that actually has the container");
				assert.strictEqual(target.name, realTarget.name);
			} finally {
				process.env.PATH = originalPath;
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	console.log(`\n${failed === 0 ? "ALL TESTS PASSED" : "SOME TESTS FAILED"}: ${passed} passed, ${failed} failed\n`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
