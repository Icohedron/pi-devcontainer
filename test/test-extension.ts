/**
 * Extension-level tests: drives index.ts with a mock ExtensionAPI.
 * Usage: node test-extension.ts <container|host>
 * The scenario is selected by the working directory the process starts in.
 */

import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectRuntimes, findRunningContainer } from "../src/container.ts";
import { findDevcontainerConfig } from "../src/discovery.ts";

type Handler = (event: any, ctx: any) => any;

const scenario = process.argv[2] ?? "container";

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

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

// --- Mock host -------------------------------------------------------------

const handlers = new Map<string, Handler[]>();
const tools = new Map<string, any>();
const commands = new Map<string, any>();
const notifications: Array<{ message: string; level: string }> = [];
const statuses: Array<string | undefined> = [];
const customFactories: any[] = [];

const pi: any = {
	on(event: string, handler: Handler) {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
	registerTool(tool: any) {
		tools.set(tool.name, tool);
	},
	registerCommand(name: string, options: any) {
		commands.set(name, options);
	},
	registerFlag() {},
	getFlag: (name: string) => (name === "no-devcontainer" ? scenario === "disabled" : undefined),
	events: { emit() {}, on() {} },
};

const ctx: any = {
	hasUI: true,
	mode: "tui",
	cwd: process.cwd(),
	signal: undefined,
	isProjectTrusted: () => true,
	model: { provider: "test-provider", id: "test-model" },
	thinkingLevel: "high",
	sessionManager: {
		getSessionId: () => "session-under-test",
		getSessionFile: () => "/host/only/session.jsonl",
	},
	ui: {
		notify(message: string, level = "info") {
			notifications.push({ message, level });
		},
		setStatus(_key: string, value: string | undefined) {
			statuses.push(value);
		},
		theme: { fg: (_key: string, text: string) => text, bold: (text: string) => text },
		custom: async (factory: any) => {
			customFactories.push(factory);
			return undefined;
		},
	},
};

/** Wait for the background detection kicked off by session_start. */
async function settle(check: () => boolean, label: string): Promise<void> {
	for (let waited = 0; waited < 30_000; waited += 50) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function emit(event: string, payload: any = {}): Promise<any[]> {
	const results: any[] = [];
	for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
	return results;
}

/** Point HOME at a throwaway tree so user settings can be controlled. */
function fakeHome(settings: unknown): void {
	const home = mkdtempSync(path.join(tmpdir(), "dc-home-"));
	mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	mkdirSync(path.join(home, ".config"), { recursive: true });
	mkdirSync(path.join(home, ".local", "share"), { recursive: true });
	// podman keeps its rootless state under HOME; keep pointing at the real one.
	for (const rel of [".config/containers", ".local/share/containers"]) {
		try {
			symlinkSync(path.join(process.env.HOME ?? "", rel), path.join(home, rel));
		} catch {
			// absent on this machine; detection will simply find nothing
		}
	}
	writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify(settings));
	process.env.HOME = home;
}

async function main(): Promise<void> {
	if (scenario === "strict") fakeHome({ devcontainer: { requireContainer: true } });

	// Start pi well below the directory holding .devcontainer.
	let nestedDir: string | undefined;
	if (scenario === "nested") {
		nestedDir = path.join(process.cwd(), "src", "deeply", "nested");
		mkdirSync(nestedDir, { recursive: true });
		writeFileSync(path.join(nestedDir, "marker.txt"), "nested-marker\n");
		process.chdir(nestedDir);
	}

	const extension = await import("../src/index.ts");
	extension.default(pi);

	console.log(`\n--- extension load (${scenario}) ---`);

	await test("registers overrides for every built-in file/exec tool", () => {
		for (const name of ["read", "write", "edit", "bash", "grep", "find", "ls"]) {
			assert.ok(tools.has(name), `missing tool override: ${name}`);
		}
		assert.strictEqual(tools.size, 7);
	});

	await test("registers the /devcontainer command", () => {
		assert.ok(commands.has("devcontainer"));
	});

	await test("subscribes to the routing lifecycle events", () => {
		for (const event of ["session_start", "session_shutdown", "before_agent_start", "user_bash"]) {
			assert.ok((handlers.get(event) ?? []).length > 0, `missing handler: ${event}`);
		}
	});

	await emit("session_start", { reason: "startup" });
	await settle(() => notifications.length > 0, "the startup notice");
	const startup = notifications.at(-1);
	assert.ok(startup);
	console.log(`        startup notice (${startup.level}):`);
	for (const line of startup.message.split("\n")) console.log(`          | ${line}`);

	// Expected values come from discovery, not from hardcoded host paths.
	const dc = findDevcontainerConfig(process.cwd());
	const runtimes = dc ? await detectRuntimes() : [];
	const discovered = dc && runtimes.length > 0 ? await findRunningContainer(runtimes, dc) : null;
	const NAME = discovered?.name ?? "";
	const WS = discovered?.containerWorkspace ?? "";
	const CONFIG = discovered?.configPath ?? "";

	if (scenario === "container") {
		console.log("\n--- routed into the container ---");

		await test("startup message announces devcontainer routing", () => {
			assert.strictEqual(startup.level, "info");
			assert.match(startup.message, /✓ All tool calls are being routed into the devcontainer/);
		});

		await test("startup message states the devcontainer.json path", () => {
			assert.ok(startup.message.includes(`devcontainer.json: ${CONFIG}`), startup.message);
		});

		await test("startup message states the running container name", () => {
			assert.ok(startup.message.includes(`container:         ${NAME}`), startup.message);
		});

		await test("footer marks contained work, without a warning sign", () => {
			const status = String(statuses.at(-1));
			assert.ok(status.includes(`devcontainer: ${NAME}`), status);
			assert.match(status, /⧉/, "the container marker should be present");
			assert.ok(!status.includes("⚠"), status);
			assert.ok(!status.includes("host"), status);
		});

		await test("bash tool executes inside the container", async () => {
			const result = await tools.get("bash").execute("t", { command: "pwd; id -un" }, undefined);
			const output = textOf(result);
			assert.ok(output.includes(WS), output);
			assert.match(output, /vscode/);
		});

		await test("ls tool lists the container workspace", async () => {
			const result = await tools.get("ls").execute("t", {}, undefined);
			assert.match(textOf(result), /devenv\.nix/);
		});

		await test("grep tool searches inside the container", async () => {
			const result = await tools.get("grep").execute("t", { pattern: "devenv", glob: "*.nix" }, undefined);
			assert.match(textOf(result), /devenv\.nix:/);
		});

		await test("system prompt tells the model it is inside the container", async () => {
			const [result] = await emit("before_agent_start", {
				systemPrompt: `Guidelines\nCurrent working directory: ${process.cwd()}\n`,
			});
			assert.ok(result?.systemPrompt, "expected a rewritten system prompt");
			assert.ok(result.systemPrompt.includes(`Current working directory: ${WS}`));
			assert.ok(result.systemPrompt.includes(`inside devcontainer "${NAME}"`));
			assert.ok(!result.systemPrompt.includes(`directory: ${process.cwd()}\n`), "host cwd line should be replaced");
		});

		await test("! commands follow the userBash setting", async () => {
			// Default is "container"; the handler returns container operations.
			const [routed] = await emit("user_bash", { command: "whoami", cwd: process.cwd() });
			assert.ok(routed?.operations, "default should route ! into the container");
		});

		await test("session variables reach container commands, except the host path", async () => {
			// pi tells the model it can read PI_*; that must stay true once routed.
			const withSession = {
				...ctx,
				model: { provider: "test-provider", id: "test-model" },
				thinkingLevel: "high",
				sessionManager: {
					getSessionId: () => "session-under-test",
					getSessionFile: () => "/host/only/session.jsonl",
				},
			};
			const run = async (command: string) =>
				textOf(await tools.get("bash").execute("t", { command }, undefined, undefined, withSession));

			assert.match(await run("printf %s \"$PI_SESSION_ID\""), /session-under-test/);
			assert.match(await run("printf %s \"$PI_MODEL\""), /test-model/);
			assert.match(await run("printf %s \"$PI_PROVIDER\""), /test-provider/);
			assert.match(await run("printf %s \"$PI_REASONING_LEVEL\""), /high/);
			assert.ok(
				!(await run('printf %s "$PI_SESSION_FILE"')).includes("/host/only"),
				"a host path must not be handed to the container",
			);
		});

		await test("user_bash ! commands are routed into the container", async () => {
			const [result] = await emit("user_bash", { command: "pwd", cwd: process.cwd() });
			assert.ok(result?.operations, "expected container bash operations");
			let output = "";
			const exit = await result.operations.exec("pwd", process.cwd(), {
				onData: (chunk: Buffer) => {
					output += chunk.toString();
				},
			});
			assert.strictEqual(exit.exitCode, 0);
			assert.ok(output.includes(WS), output);
		});

		console.log("\n--- /devcontainer command ---");

		await test("/devcontainer host falls back to running on the host", async () => {
			await commands.get("devcontainer").handler("host", ctx);
			const result = await tools.get("bash").execute("t", { command: "pwd" }, undefined);
			assert.match(textOf(result), new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		});

		await test("/devcontainer container resumes routing", async () => {
			await commands.get("devcontainer").handler("container", ctx);
			const result = await tools.get("bash").execute("t", { command: "pwd" }, undefined);
			assert.ok(textOf(result).includes(WS), textOf(result));
		});

		await test("/devcontainer status prints the active container", async () => {
			await commands.get("devcontainer").handler("status", ctx);
			assert.match(String(notifications.at(-1)?.message), /routed into the devcontainer/);
		});

		await test("bare /devcontainer opens the details menu", async () => {
			const before = customFactories.length;
			await commands.get("devcontainer").handler("", ctx);
			assert.strictEqual(customFactories.length, before + 1, "expected a custom menu component");
		});

		console.log("\n--- losing the container mid-session ---");

		await test("a stopped container ends the turn, warns, and flips the footer", async () => {
			assert.ok(discovered);
			const { execFileSync } = await import("node:child_process");
			const runtime = discovered.runtime.bin;
			const bash = tools.get("bash");
			const call = () => bash.execute("t", { command: "whoami" }, undefined, undefined, ctx);

			assert.match(textOf(await call()), new RegExp(discovered.user ?? "\\w"));

			execFileSync(runtime, ["stop", discovered.name], { stdio: "ignore" });
			try {
				const before = notifications.length;
				const failed = await call();

				assert.strictEqual(failed.terminate, true, "the turn must stop so the user can decide");
				assert.match(textOf(failed), /no longer running/);
				assert.match(textOf(failed), /further tool calls run on the host/i);

				const warned = notifications.slice(before);
				assert.ok(
					warned.some((entry) => entry.level === "warning" && /stopped/.test(entry.message)),
					"the user must be warned",
				);
				assert.match(String(statuses.at(-1)), /devcontainer stopped/);

				// Having been told, continuing is the user's call: the fallback runs.
				const next = await call();
				assert.notStrictEqual(next.terminate, true, "continuing should not keep halting");
				assert.ok(!textOf(next).includes("did not run"), textOf(next));
			} finally {
				execFileSync(runtime, ["start", discovered.name], { stdio: "ignore" });
				for (let waited = 0; waited < 20_000; waited += 250) {
					try {
						execFileSync(runtime, ["exec", discovered.name, "true"], { stdio: "ignore" });
						break;
					} catch {
						await new Promise((resolve) => setTimeout(resolve, 250));
					}
				}
				await commands.get("devcontainer").handler("container", ctx);
			}
		});

		await test("a restarted container is not picked up until asked", async () => {
			assert.ok(discovered);
			const { execFileSync } = await import("node:child_process");
			const runtime = discovered.runtime.bin;
			const bash = tools.get("bash");
			const call = () => bash.execute("t", { command: "pwd" }, undefined, undefined, ctx);

			execFileSync(runtime, ["stop", discovered.name], { stdio: "ignore" });
			try {
				await call(); // the halting call
				assert.ok(!textOf(await call()).includes(WS), "should be on the host while it is down");
			} finally {
				execFileSync(runtime, ["start", discovered.name], { stdio: "ignore" });
				for (let waited = 0; waited < 20_000; waited += 250) {
					try {
						execFileSync(runtime, ["exec", discovered.name, "true"], { stdio: "ignore" });
						break;
					} catch {
						await new Promise((resolve) => setTimeout(resolve, 250));
					}
				}
			}

			// Tool calls do not go looking; that is what the commands are for.
			const started = Date.now();
			assert.ok(!textOf(await call()).includes(WS), "a tool call must not re-detect");
			assert.ok(Date.now() - started < 500, "and must not pay for a lookup either");
		});

		await test("an explicit /devcontainer status picks it up immediately", async () => {
			assert.ok(discovered);
			const { execFileSync } = await import("node:child_process");
			const runtime = discovered.runtime.bin;
			const bash = tools.get("bash");

			execFileSync(runtime, ["stop", discovered.name], { stdio: "ignore" });
			try {
				await bash.execute("t", { command: "pwd" }, undefined, undefined, ctx); // halting call
			} finally {
				execFileSync(runtime, ["start", discovered.name], { stdio: "ignore" });
				for (let waited = 0; waited < 20_000; waited += 250) {
					try {
						execFileSync(runtime, ["exec", discovered.name, "true"], { stdio: "ignore" });
						break;
					} catch {
						await new Promise((resolve) => setTimeout(resolve, 250));
					}
				}
			}
			await commands.get("devcontainer").handler("status", ctx);
			const result = await bash.execute("t", { command: "pwd" }, undefined, undefined, ctx);
			assert.ok(textOf(result).includes(WS), "status must re-check rather than trust a stale answer");
		});

		await test("a short /dc alias exists and takes the same arguments", async () => {
			assert.ok(commands.has("dc"), "expected a short alias");
			const bash = tools.get("bash");
			const where = async () =>
				textOf(await bash.execute("t", { command: "pwd" }, undefined, undefined, ctx));

			await commands.get("dc").handler("off", ctx);
			assert.ok(!(await where()).includes(WS), "/dc off should move to the host");
			await commands.get("dc").handler("on", ctx);
			assert.ok((await where()).includes(WS), "/dc on should route back into the container");
		});

		await test("argument completions offer the short forms first", () => {
			const values = commands.get("devcontainer").getArgumentCompletions("")?.map((i: any) => i.value);
			assert.deepStrictEqual(values?.slice(0, 2), ["on", "off"]);
			assert.deepStrictEqual(
				commands.get("dc").getArgumentCompletions("o")?.map((i: any) => i.value),
				["on", "off"],
			);
		});
	} else if (scenario === "nested") {
		console.log("\n--- started in a subdirectory of the project ---");
		const repoRoot = path.resolve(import.meta.dirname, "..");
		const expected = `${WS}/src/deeply/nested`;

		await test("the devcontainer is still found by walking up", () => {
			assert.ok(discovered, "should find the config in an ancestor");
			assert.strictEqual(discovered.hostWorkspace, repoRoot);
			assert.match(startup.message, /routed into the devcontainer/);
		});

		await test("routed commands run in the session directory, not the workspace root", async () => {
			const result = await tools.get("bash").execute("t", { command: "pwd" }, undefined, undefined, ctx);
			assert.strictEqual(textOf(result).trim(), expected, "relative work must not jump to the root");
		});

		await test("relative paths resolve against the session directory", async () => {
			const result = await tools.get("read").execute("t", { path: "marker.txt" }, undefined, undefined, ctx);
			assert.match(textOf(result), /nested-marker/);
		});

		await test("grep searches the session directory by default", async () => {
			const result = await tools.get("grep").execute("t", { pattern: "nested-marker" }, undefined, undefined, ctx);
			assert.match(textOf(result), /marker\.txt/);
		});

		await test("the model is told the session directory", async () => {
			const [result] = await emit("before_agent_start", {
				systemPrompt: `Current working directory: ${process.cwd()}`,
			});
			assert.ok(result.systemPrompt.includes(`Current working directory: ${expected}`), result.systemPrompt);
			assert.match(result.systemPrompt, new RegExp(`mounted at ${WS}`));
		});

		await test("/devcontainer up targets the config directory, not the session directory", async () => {
			const { mkdtempSync, chmodSync, readFileSync: read } = await import("node:fs");
			const shimDir = mkdtempSync(path.join(tmpdir(), "dc-up-"));
			const log = path.join(shimDir, "argv.log");
			const shim = path.join(shimDir, "fake-devcontainer");
			writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(log)}\nexit 0\n`);
			chmodSync(shim, 0o755);
			const { devcontainerUp } = await import("../src/container.ts");
			const { DEFAULT_CONFIG } = await import("../src/config.ts");
			try {
				assert.ok(discovered);
				await devcontainerUp(
					discovered.hostWorkspace,
					{ ...DEFAULT_CONFIG, devcontainerPath: shim },
					undefined,
					`${discovered.hostWorkspace}/.devcontainer/devcontainer.json`,
				);
				const argv = read(log, "utf8").trim();
				assert.match(argv, new RegExp(`--workspace-folder ${repoRoot}(\\s|$)`));
				assert.ok(!argv.includes("deeply/nested --config"), argv);
			} finally {
				rmSync(shimDir, { recursive: true, force: true });
			}
		});
	} else if (scenario === "strict") {
		console.log("\n--- requireContainer, and losing the container ---");

		await test("startup says tool calls will not fall back to the host", () => {
			assert.ok(discovered, "this scenario needs a running devcontainer");
			assert.match(startup.message, /routed into the devcontainer/);
		});

		await test("advice after losing the container never offers host execution", async () => {
			assert.ok(discovered);
			const { execFileSync } = await import("node:child_process");
			const runtime = discovered.runtime.bin;
			const bash = tools.get("bash");
			const call = () => bash.execute("t", { command: "whoami" }, undefined, undefined, ctx);

			execFileSync(runtime, ["stop", discovered.name], { stdio: "ignore" });
			try {
				const first = await call();
				assert.strictEqual(first.terminate, true);
				assert.match(textOf(first), /requireContainer is set/, "the first failure must cite requireContainer");

				const second = await call();
				assert.strictEqual(second.terminate, true);
				assert.match(textOf(second), /never run on the host/);
				assert.ok(
					!textOf(second).includes("/devcontainer host to accept"),
					"must not suggest a remedy requireContainer forbids",
				);

				// And the command itself refuses rather than quietly doing nothing.
				const before = notifications.length;
				await commands.get("devcontainer").handler("host", ctx);
				const said = notifications.slice(before).map((entry) => entry.message).join(" ");
				assert.match(said, /requireContainer is set/);
				assert.strictEqual(notifications.at(-1)?.level, "error");

				const after = await call();
				assert.strictEqual(after.terminate, true, "/devcontainer host must not enable host execution");
			} finally {
				execFileSync(runtime, ["start", discovered.name], { stdio: "ignore" });
				for (let waited = 0; waited < 20_000; waited += 250) {
					try {
						execFileSync(runtime, ["exec", discovered.name, "true"], { stdio: "ignore" });
						break;
					} catch {
						await new Promise((resolve) => setTimeout(resolve, 250));
					}
				}
			}
		});
	} else if (scenario === "disabled") {
		console.log("\n--- routing disabled by --no-devcontainer ---");

		await test("startup warns that routing is disabled", () => {
			assert.strictEqual(startup.level, "warning");
			assert.match(startup.message, /⚠ Devcontainer routing is disabled\. All tool calls are running on the host\./);
		});

		await test("startup still reports the available container and config", () => {
			assert.match(startup.message, /devcontainer\.json: .*\.devcontainer\/devcontainer\.json/);
			assert.ok(startup.message.includes(`container:         ${NAME} (available, not in use)`), startup.message);
		});

		await test("bash runs on the host despite an available container", async () => {
			const result = await tools.get("bash").execute("t", { command: "pwd" }, undefined);
			assert.match(textOf(result), new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		});

		await test("system prompt is not rewritten while disabled", async () => {
			const results = await emit("before_agent_start", { systemPrompt: "unchanged" });
			assert.ok(results.every((r) => r === undefined));
		});

		await test("/devcontainer container re-enables routing", async () => {
			await commands.get("devcontainer").handler("container", ctx);
			const result = await tools.get("bash").execute("t", { command: "pwd" }, undefined);
			assert.ok(textOf(result).includes(WS), textOf(result));
		});
	} else {
		console.log("\n--- host fallback (no devcontainer) ---");

		await test("startup warns that tool calls run on the host", () => {
			assert.strictEqual(startup.level, "warning");
			assert.match(startup.message, /⚠ No devcontainer found\. All tool calls are running on the host\./);
			assert.match(startup.message, new RegExp(`host workspace: ${process.cwd()}`));
		});

		await test("footer warns loudly when tool calls run on the host", () => {
			const status = String(statuses.at(-1));
			assert.match(status, /⚠/, "a warning sign should mark host execution");
			assert.match(status, /host/, "and it should say where work runs");
			assert.match(status, /no devcontainer/);
		});

		await test("bash runs on the host", async () => {
			const result = await tools.get("bash").execute("t", { command: "pwd" }, undefined);
			assert.match(textOf(result), new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		});

		await test("read reads host files", async () => {
			const result = await tools.get("read").execute("t", { path: "host-marker.txt" }, undefined);
			assert.match(textOf(result), /on-the-host/);
		});

		await test("system prompt is left untouched", async () => {
			const results = await emit("before_agent_start", { systemPrompt: "unchanged" });
			assert.ok(results.every((r) => r === undefined), "no system prompt rewrite expected");
		});

		await test("user_bash stays on the host", async () => {
			const results = await emit("user_bash", { command: "pwd", cwd: process.cwd() });
			assert.ok(results.every((r) => r === undefined), "no container operations expected");
		});
	}

	if (nestedDir) {
		// Scratch created by this scenario; do not leave it in the source tree.
		process.chdir(path.resolve(nestedDir, "..", "..", ".."));
		rmSync(path.resolve(nestedDir, ".."), { recursive: true, force: true });
	}

	await emit("session_shutdown", { reason: "quit" });
	await test("shutdown clears the status entry", () => {
		assert.strictEqual(statuses.at(-1), undefined);
	});

	console.log(`\n${failed === 0 ? "ALL TESTS PASSED" : "SOME TESTS FAILED"}: ${passed} passed, ${failed} failed\n`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
