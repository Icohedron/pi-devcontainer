/**
 * Escape tests.
 *
 * With routing active and no host-command allowance configured, no tool may
 * reach the host filesystem or run a host binary. The one deliberate opening is
 * the workspace bind mount, which is shared by design; that is asserted too, so
 * the boundary is written down rather than assumed.
 *
 * Usage: node test/test-escape.ts
 */

import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { containerExec, detectRuntimes, findRunningContainer } from "../src/container.ts";
import { findDevcontainerConfig } from "../src/discovery.ts";
import { planHostCommand } from "../src/routing.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const SECRET = "HOST-ONLY-SECRET-e7c1";

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

/** Run a tool and return its output, whether it resolved or threw. */
async function attempt(run: () => Promise<any>): Promise<string> {
	try {
		return textOf(await run());
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

async function main(): Promise<void> {
	const devcontainer = findDevcontainerConfig(REPO);
	const runtimes = devcontainer ? await detectRuntimes() : [];
	const target = devcontainer && runtimes.length > 0 ? await findRunningContainer(runtimes, devcontainer) : null;

	if (!target) {
		console.log("\n  SKIP  no running devcontainer\n");
		process.exit(0);
	}

	const {
		createBashTool,
		createEditTool,
		createFindTool,
		createLsTool,
		createReadTool,
		createWriteTool,
	} = await import("@earendil-works/pi-coding-agent");
	const ops = await import("../src/operations.ts");

	// A file on the host, outside the workspace, that the container has no path to.
	const hostDir = mkdtempSync(path.join(tmpdir(), "pi-escape-"));
	const hostFile = path.join(hostDir, "host-secret.txt");
	writeFileSync(hostFile, `${SECRET}\n`);

	const cwd = target.containerWorkspace;
	const read = createReadTool(cwd, { operations: ops.createContainerReadOps(target) });
	const write = createWriteTool(cwd, { operations: ops.createContainerWriteOps(target) });
	const edit = createEditTool(cwd, { operations: ops.createContainerEditOps(target) });
	const ls = createLsTool(cwd, { operations: ops.createContainerLsOps(target) });
	const find = createFindTool(cwd, { operations: ops.createContainerFindOps(target) });
	const bash = createBashTool(cwd, { operations: ops.createContainerBashOps(target, "bash") });

	try {
		console.log("\n--- ground truth ---");

		await test("the host marker is genuinely invisible to the container", async () => {
			const probe = await containerExec(target, ["test", "-e", hostDir]);
			assert.notStrictEqual(probe.exitCode, 0, "host tmp must not be shared, or these tests prove nothing");
			assert.ok(existsSync(hostFile), "the marker must exist on the host");
		});

		console.log("\n--- no tool can read the host ---");

		await test("read cannot reach a host-only file", async () => {
			const output = await attempt(() => read.execute("t", { path: hostFile }, undefined));
			assert.ok(!output.includes(SECRET), output);
		});

		await test("bash cannot cat a host-only file", async () => {
			const output = await attempt(() => bash.execute("t", { command: `cat ${JSON.stringify(hostFile)}` }, undefined));
			assert.ok(!output.includes(SECRET), output);
		});

		await test("ls cannot list a host-only directory", async () => {
			const output = await attempt(() => ls.execute("t", { path: hostDir }, undefined));
			assert.ok(!output.includes("host-secret.txt"), output);
		});

		await test("find cannot search a host-only directory", async () => {
			const output = await attempt(() => find.execute("t", { pattern: "*.txt", path: hostDir }, undefined));
			assert.ok(!output.includes("host-secret.txt"), output);
		});

		await test("grep cannot search a host-only directory", async () => {
			const output = await attempt(() =>
				ops.executeContainerGrep(target, { pattern: SECRET, path: hostDir }, { hasRipgrep: false }),
			);
			assert.ok(!output.includes(SECRET) || /No matches|not found/i.test(output), output);
		});

		console.log("\n--- no tool can write to the host ---");

		await test("write does not modify a host-only file", async () => {
			await attempt(() => write.execute("t", { path: hostFile, content: "OVERWRITTEN\n" }, undefined));
			assert.strictEqual(readFileSync(hostFile, "utf8"), `${SECRET}\n`, "the host file must be untouched");
		});

		await test("write does not create files on the host", async () => {
			const newHostPath = path.join(hostDir, "created-by-agent.txt");
			await attempt(() => write.execute("t", { path: newHostPath, content: "x" }, undefined));
			assert.ok(!existsSync(newHostPath), "a host file was created");
		});

		await test("edit cannot change a host-only file", async () => {
			await attempt(() =>
				edit.execute("t", { path: hostFile, edits: [{ oldText: SECRET, newText: "TAMPERED" }] }, undefined),
			);
			assert.strictEqual(readFileSync(hostFile, "utf8"), `${SECRET}\n`);
		});

		console.log("\n--- no tool escapes by other means ---");

		await test("relative traversal stays inside the container", async () => {
			const output = await attempt(() =>
				bash.execute("t", { command: "cat ../../../../etc/hostname" }, undefined),
			);
			assert.ok(!output.includes(hostname()), `leaked the host hostname: ${output}`);
		});

		await test("absolute paths resolve in the container, not the host", async () => {
			const output = await attempt(() => read.execute("t", { path: "/etc/os-release" }, undefined));
			assert.match(output, /Ubuntu/i, "should be the container's /etc/os-release");
		});

		await test("host binaries are not reachable from a routed command", async () => {
			for (const binary of ["podman", "docker", "devcontainer"]) {
				const output = await attempt(() =>
					bash.execute("t", { command: `command -v ${binary} && ${binary} --version` }, undefined),
				);
				assert.ok(!/podman version|Docker version|@devcontainers\/cli/i.test(output), `${binary}: ${output}`);
			}
		});

		await test("commands run as the container user, not the host user", async () => {
			const output = await attempt(() => bash.execute("t", { command: "id -un" }, undefined));
			assert.ok(!output.includes(process.env.USER ?? "\\0"), output);
		});

		await test("with no hostCommands, nothing is planned for the host", () => {
			for (const command of ["herdr", "tuicr review", "sh", "bash -c id", "/bin/sh"]) {
				assert.strictEqual(planHostCommand(command, []).mode, "container", command);
			}
		});

		console.log("\n--- the deliberate opening ---");

		await test("the workspace mount is shared, by design", async () => {
			const marker = path.join(REPO, ".escape-probe.txt");
			try {
				await bash.execute("t", { command: `printf shared > ${JSON.stringify(cwd)}/.escape-probe.txt` }, undefined);
				assert.strictEqual(readFileSync(marker, "utf8"), "shared", "the mounted workspace is intentionally shared");
			} finally {
				rmSync(marker, { force: true });
			}
		});
	} finally {
		rmSync(hostDir, { recursive: true, force: true });
	}

	console.log(`\n${failed === 0 ? "ALL TESTS PASSED" : "SOME TESTS FAILED"}: ${passed} passed, ${failed} failed\n`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
