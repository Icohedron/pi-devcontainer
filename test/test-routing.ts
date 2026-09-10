/**
 * Host-command execution: where a command actually runs, what it receives, and
 * that no shell is involved on the host side.
 *
 * The matcher rules themselves are covered in test-security.ts.
 *
 * Usage: node test/test-routing.ts
 */

import assert from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectRuntimes, findRunningContainer } from "../src/container.ts";
import { findDevcontainerConfig } from "../src/discovery.ts";
import { planHostCommand } from "../src/routing.ts";

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

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

async function main(): Promise<void> {
	console.log("\n--- execution while routing is active ---");

	const devcontainer = findDevcontainerConfig(REPO);
	const runtimes = devcontainer ? await detectRuntimes() : [];
	const target = devcontainer && runtimes.length > 0 ? await findRunningContainer(runtimes, devcontainer) : null;

	if (!target) {
		console.log("  SKIP  no running devcontainer");
	} else {
		let createBashTool: typeof import("@earendil-works/pi-coding-agent").createBashTool;
		let createContainerBashOps: typeof import("../src/operations.ts").createContainerBashOps;
		let createHostArgvOperations: typeof import("../src/operations.ts").createHostArgvOperations;
		try {
			({ createBashTool } = await import("@earendil-works/pi-coding-agent"));
			({ createContainerBashOps, createHostArgvOperations } = await import("../src/operations.ts"));
		} catch {
			console.log("  SKIP  pi packages are not linked; run pi-link-deps for the execution tests");
			console.log(`\n${failed === 0 ? "ALL TESTS PASSED" : "SOME TESTS FAILED"}: ${passed} passed, ${failed} failed\n`);
			process.exit(failed === 0 ? 0 : 1);
		}

		// A tool that exists on the host and definitely not in the container.
		// It records exactly the argv it was given.
		const dir = mkdtempSync(path.join(tmpdir(), "dc-hosttool-"));
		const toolName = "pi-host-only-tool";
		const argvLog = path.join(dir, "argv.log");
		writeFileSync(
			path.join(dir, toolName),
			`#!/bin/sh\n: > ${JSON.stringify(argvLog)}\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(argvLog)}; done\necho "ran on host in $(pwd)"\n`,
		);
		chmodSync(path.join(dir, toolName), 0o755);
		const originalPath = process.env.PATH;
		process.env.PATH = `${dir}:${originalPath}`;

		const containerBash = createBashTool(target.containerWorkspace, {
			operations: createContainerBashOps(target, "bash"),
		});

		/** Mirror of the extension's bash override. */
		const run = async (command: string, hostCommands: string[]) => {
			const plan = planHostCommand(command, hostCommands);
			if (plan.mode === "blocked") throw new Error(`Refused to run this on the host: ${plan.reason}.`);
			if (plan.mode === "host") {
				const tool = createBashTool(target.hostWorkspace, {
					operations: createHostArgvOperations(plan.argv),
				});
				return tool.execute("t", { command }, undefined);
			}
			return containerBash.execute("t", { command }, undefined);
		};

		try {
			await test("a host-only tool fails inside the container when not listed", async () => {
				await assert.rejects(() => run(toolName, []), /not found/);
			});

			await test("listing it in hostCommands makes it run, on the host, in the host workspace", async () => {
				const result = await run(toolName, [toolName]);
				const output = textOf(result);
				assert.match(output, /ran on host/);
				assert.match(output, new RegExp(target.hostWorkspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			});

			await test("arguments are passed to the host exactly as written", async () => {
				// No translation in either direction: a host command receives what
				// it was given, so a path that means something on the host is the
				// caller's job. Mounting the workspace at the same path on both
				// sides is what makes one spelling work everywhere.
				await run(`${toolName} ${target.containerWorkspace}/README.md`, [toolName]);
				assert.strictEqual(readFileSync(argvLog, "utf8").trim(), `${target.containerWorkspace}/README.md`);
			});

			await test("arguments reach the program verbatim, with no shell expansion", async () => {
				// A shell would glob "*.ts", split "two words" and expand "~".
				await run(`${toolName} *.ts "two words" ~`, [toolName]);
				assert.deepStrictEqual(readFileSync(argvLog, "utf8").split("\n").filter(Boolean), [
					"*.ts",
					"two words",
					"~",
				]);
			});

			await test("$ is rejected even though argv exec would make it harmless", async () => {
				await assert.rejects(() => run(`${toolName} $HOME`, [toolName]), /contains "\$"/);
			});

			await test("an injection attempt is refused rather than run anywhere", async () => {
				await assert.rejects(
					() => run(`${toolName}; whoami`, [toolName]),
					/Refused to run this on the host/,
				);
			});

			await test("other commands still run in the container", async () => {
				const result = await run("pwd; cat /etc/os-release | head -1", [toolName]);
				const output = textOf(result);
				assert.match(output, new RegExp(target.containerWorkspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
				assert.match(output, /Ubuntu/i);
			});
		} finally {
			process.env.PATH = originalPath;
			rmSync(dir, { recursive: true, force: true });
		}
	}

	console.log(`\n${failed === 0 ? "ALL TESTS PASSED" : "SOME TESTS FAILED"}: ${passed} passed, ${failed} failed\n`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
