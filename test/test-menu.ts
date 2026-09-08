/**
 * Menu tests: renders the real /devcontainer menu component headlessly and
 * drives the routing toggle through SettingsList.
 * Usage: node test-menu.ts   (run from a project with a running devcontainer)
 */

import assert from "node:assert";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { detectRuntimes, findRunningContainer } from "../src/container.ts";
import { findDevcontainerConfig } from "../src/discovery.ts";

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

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");

async function main(): Promise<void> {
	// getSettingsListTheme() reads pi's global theme; the extension only needs fg/bold.
	initTheme();
	const theme: any = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
	};

	const handlers = new Map<string, any[]>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const statuses: Array<string | undefined> = [];

	let customFactory: any;
	let doneFn: any;

	const pi: any = {
		on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, options: any) => commands.set(name, options),
		registerFlag() {},
		getFlag: () => undefined,
		events: { emit() {}, on() {} },
	};

	const tui: any = { requestRender() {} };

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
	model: { provider: "test-provider", id: "test-model" },
	thinkingLevel: "high",
	sessionManager: {
		getSessionId: () => "session-under-test",
		getSessionFile: () => "/host/only/session.jsonl",
	},
		ui: {
			notify() {},
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			theme,
			custom: async (factory: any) => {
				customFactory = factory;
				return new Promise((resolve) => {
					doneFn = resolve;
				});
			},
		},
	};

	const dc = findDevcontainerConfig(process.cwd());
	const runtimes = dc ? await detectRuntimes() : [];
	const discovered = dc && runtimes.length > 0 ? await findRunningContainer(runtimes, dc) : null;
	assert.ok(discovered, "these tests need a running devcontainer for this repo");
	const NAME = discovered.name;
	const WS = discovered.containerWorkspace;
	const CONFIG = discovered.configPath;

	const extension = await import("../src/index.ts");
	extension.default(pi);
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
	// session_start now detects in the background so pi starts immediately.
	for (let waited = 0; waited < 30_000 && statuses.length === 0; waited += 50) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	console.log("\n--- status bar ---");

	await test("status bar names the devcontainer that tools route through", () => {
		const status = strip(String(statuses.at(-1)));
		assert.ok(status.includes(`devcontainer: ${NAME}`), status);
		assert.ok(!status.includes("host"), `expected routed status, got: ${status}`);
	});

	console.log("\n--- /devcontainer menu ---");

	// The menu blocks on ctx.ui.custom until done() is called.
	const menuPromise = commands.get("devcontainer").handler("", ctx);
	menuPromise.catch((error: unknown) => console.log("        menu handler rejected:", error));
	// Poll instead of sleeping: container inspection time varies.
	for (let waited = 0; !customFactory && waited < 20_000; waited += 50) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	await test("bare /devcontainer opens a custom component", () => {
		assert.ok(customFactory, "expected ctx.ui.custom to be called");
	});

	const component = customFactory(tui, theme, undefined, (value: any) => doneFn(value));
	const frame = () => component.render(100).map(strip).join("\n");
	const initial = frame();
	console.log(initial.split("\n").map((line) => `        | ${line}`).join("\n"));

	await test("menu shows a titled panel", () => {
		assert.match(initial, /Devcontainer/);
	});

	await test("menu lists the config path and container identity", () => {
		assert.match(initial, new RegExp(`Config +${CONFIG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(initial, new RegExp(`Container +${NAME} \\([0-9a-f]{12}\\)`));
	});

	await test("menu shows extra container details", () => {
		assert.match(initial, /Image +\S+/);
		assert.match(initial, /Runtime +podman · running · up /);
		assert.match(initial, new RegExp(`Workspace +${WS}`));
		assert.match(initial, new RegExp(`Host path +${process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(initial, /User +vscode/);
		assert.match(initial, /Shell +bash · ripgrep: no \(using grep\)/);
	});

	await test("menu lists the routed tools", () => {
		assert.match(initial, /Routed tools +read, write, edit, bash, grep, find, ls/);
	});

	await test("menu shows the routing toggle set to on", () => {
		assert.match(initial, /Route tool calls into container/);
		assert.match(initial, /\bon\b/);
		assert.match(initial, /Enter\/Space to change/i);
	});

	console.log("\n--- toggle behaviour ---");

	await test("toggling off switches tool calls to the host", async () => {
		component.handleInput(" ");
		const toggled = frame();
		assert.match(toggled, /Tool calls +running on host/, "detail row should update live");
		const result = await tools.get("bash").execute("t", { command: "pwd" }, undefined);
		const output = result.content.map((c: any) => c.text ?? "").join("\n");
		assert.match(output, new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	});

	await test("toggling off updates the status bar to host", () => {
		const status = strip(String(statuses.at(-1)));
		assert.match(status, /host/);
		assert.ok(status.includes(`${NAME} (off)`), status);
	});

	await test("toggling back on resumes container routing", async () => {
		component.handleInput(" ");
		const toggled = frame();
		assert.match(toggled, /Tool calls +routed into container/);
		const result = await tools.get("bash").execute("t", { command: "pwd" }, undefined);
		const output = result.content.map((c: any) => c.text ?? "").join("\n");
		assert.ok(output.includes(WS), output);
		assert.ok(strip(String(statuses.at(-1))).includes(`devcontainer: ${NAME}`));
	});

	await test("escape closes the menu", async () => {
		component.handleInput("\u001b");
		await menuPromise;
	});

	console.log(`\n${failed === 0 ? "ALL TESTS PASSED" : "SOME TESTS FAILED"}: ${passed} passed, ${failed} failed\n`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
