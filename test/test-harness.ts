/**
 * Integration tests for the devcontainer routing extension.
 * Run from the extension directory: node test-harness.ts
 */

import assert from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import {
	containerExec,
	containerHasCommand,
	containerPathFor,
	detectRuntimes,
	findRunningContainer,
	resolveSessionDirectory,
} from "../src/container.ts";
import { findDevcontainerConfig } from "../src/discovery.ts";
import {
	createContainerBashOps,
	createContainerEditOps,
	createContainerFindOps,
	createContainerLsOps,
	createContainerReadOps,
	createContainerWriteOps,
	executeContainerGrep,
	toContainerPath,
} from "../src/operations.ts";

const PROJECT = path.resolve(import.meta.dirname, "..");
const SCRATCH = path.join(PROJECT, ".dc-test-scratch");

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
	// Pure discovery/JSONC unit tests live in test-discovery.ts.
	console.log("\n--- container discovery ---");

	const runtimes = await detectRuntimes();
	await test("detects an available container runtime", () => {
		assert.ok(runtimes.length > 0, "expected docker or podman");
	});

	const devcontainer = findDevcontainerConfig(PROJECT);
	assert.ok(devcontainer && runtimes.length > 0);
	const target = await findRunningContainer(runtimes, devcontainer);

	await test("finds the running container via devcontainer labels", () => {
		assert.ok(target, "expected a running container for this workspace");
		assert.ok(target.name.length > 0, "container should have a name");
	});
	assert.ok(target);
	console.log(`        container=${target.name} workspace=${target.containerWorkspace} user=${target.user}`);

	await test("resolves the container workspace from the bind mount", () => {
		assert.ok(path.posix.isAbsolute(target.containerWorkspace), "container workspace must be absolute");
		assert.strictEqual(target.hostWorkspace, PROJECT);
	});

	await test("execs as the configured remote user", async () => {
		const result = await containerExec(target, ["id", "-un"]);
		assert.strictEqual(result.exitCode, 0);
		assert.strictEqual(result.stdout.toString().trim(), target.user);
	});

	console.log("\n--- path resolution ---");

	await test("an absolute path is taken as written, as a container path", () => {
		assert.strictEqual(toContainerPath(target, "/etc/hostname"), "/etc/hostname");
	});

	await test("a host workspace path is not translated to the container workspace", () => {
		// The two are the same file only when the workspace is bind-mounted.
		// A devcontainer that clones into a volume, or bakes its sources into
		// the image, has no such mount, and translating would then address a
		// different copy without saying so. index.ts refuses these instead.
		if (target.hostWorkspace === target.containerWorkspace) {
			console.log("        (workspace is mounted at the same path, so there is nothing to translate)");
			return;
		}
		assert.strictEqual(toContainerPath(target, `${PROJECT}/devenv.nix`), `${PROJECT}/devenv.nix`);
		assert.strictEqual(toContainerPath(target, PROJECT), PROJECT);
	});

	await test("resolves relative paths against the container workspace", () => {
		assert.strictEqual(toContainerPath(target, "thing/x.txt"), `${target.containerWorkspace}/thing/x.txt`);
	});

	await test("strips a leading @ from model-supplied paths", () => {
		assert.strictEqual(toContainerPath(target, "@devenv.nix"), `${target.containerWorkspace}/devenv.nix`);
	});

	console.log("\n--- the session directory ---");

	await test("a subdirectory of the workspace maps to the same subdirectory in the container", async () => {
		const started = path.join(target.hostWorkspace, "src");
		const resolved = await resolveSessionDirectory(target, started);
		assert.strictEqual(resolved.directory, containerPathFor(target, started));
		assert.strictEqual(resolved.missing, undefined);

		// And the container agrees, which is the part worth checking.
		const result = await containerExec(target, ["bash", "-lc", "pwd"], { cwd: resolved.directory });
		assert.strictEqual(result.stdout.toString().trim(), resolved.directory);
	});

	await test("a directory the container does not have falls back to the workspace root", async () => {
		// The clone-in-volume case in miniature. Without this the runtime fails
		// every call with "attempted to invoke a command that was not found",
		// which names the wrong problem.
		const started = path.join(target.hostWorkspace, "not-in-the-container");
		const resolved = await resolveSessionDirectory(target, started);
		assert.strictEqual(resolved.directory, target.containerWorkspace);
		assert.strictEqual(resolved.missing, containerPathFor(target, started));

		const result = await containerExec(target, ["bash", "-lc", "pwd"], { cwd: resolved.directory });
		assert.strictEqual(result.exitCode, 0, "the fallback must actually run");
	});

	await test("the probe is what decides, not a guess about the mount", async () => {
		const started = path.join(target.hostWorkspace, "src");
		const denied = await resolveSessionDirectory(target, started, async () => false);
		assert.strictEqual(denied.directory, target.containerWorkspace);
		const allowed = await resolveSessionDirectory(target, started, async () => true);
		assert.strictEqual(allowed.directory, containerPathFor(target, started));
	});

	console.log("\n--- routed tools ---");

	const shell = (await containerHasCommand(target, "bash")) ? "bash" : "sh";
	const hasRipgrep = await containerHasCommand(target, "rg");
	console.log(`        shell=${shell} ripgrep=${hasRipgrep}`);

	const cwd = target.containerWorkspace;
	const readTool = createReadTool(cwd, { operations: createContainerReadOps(target) });
	const writeTool = createWriteTool(cwd, { operations: createContainerWriteOps(target) });
	const editTool = createEditTool(cwd, { operations: createContainerEditOps(target) });
	const bashTool = createBashTool(cwd, { operations: createContainerBashOps(target, shell) });
	const lsTool = createLsTool(cwd, { operations: createContainerLsOps(target) });
	const findTool = createFindTool(cwd, { operations: createContainerFindOps(target) });

	rmSync(SCRATCH, { recursive: true, force: true });

	await test("bash runs inside the container, not the host", async () => {
		const result = await bashTool.execute("t", { command: "cat /etc/os-release | head -1; pwd" }, undefined);
		const output = textOf(result);
		assert.match(output, /Ubuntu/i, "should report the container OS");
		assert.ok(output.includes(target.containerWorkspace), "should run in the container workspace");
		assert.ok(!output.includes("NixOS"), "must not be the host OS");
	});

	await test("write creates a file visible on the host through the bind mount", async () => {
		await writeTool.execute(
			"t",
			{ path: ".dc-test-scratch/hello.txt", content: "written-in-container\n" },
			undefined,
		);
		const hostPath = path.join(SCRATCH, "hello.txt");
		assert.ok(existsSync(hostPath), "file should appear on the host");
		assert.strictEqual(readFileSync(hostPath, "utf8"), "written-in-container\n");
	});

	await test("read returns container file contents", async () => {
		const result = await readTool.execute("t", { path: ".dc-test-scratch/hello.txt" }, undefined);
		assert.match(textOf(result), /written-in-container/);
	});

	await test("read of a host absolute path does not silently find the container's copy", async () => {
		// The extension refuses these with the container path in the message;
		// at this layer the point is that nothing is redirected.
		if (target.hostWorkspace === target.containerWorkspace) {
			console.log("        (same path on both sides, so there is nothing to redirect)");
			return;
		}
		await assert.rejects(() => readTool.execute("t", { path: path.join(SCRATCH, "hello.txt") }, undefined));
	});

	await test("read reports missing files as an error", async () => {
		await assert.rejects(() => readTool.execute("t", { path: ".dc-test-scratch/nope.txt" }, undefined));
	});

	await test("edit applies exact replacements in the container", async () => {
		await editTool.execute(
			"t",
			{ path: ".dc-test-scratch/hello.txt", edits: [{ oldText: "written-in", newText: "edited-in" }] },
			undefined,
		);
		assert.strictEqual(readFileSync(path.join(SCRATCH, "hello.txt"), "utf8"), "edited-in-container\n");
	});

	await test("host-side changes are visible to container reads", async () => {
		writeFileSync(path.join(SCRATCH, "from-host.txt"), "host-wrote-this\n");
		const result = await readTool.execute("t", { path: ".dc-test-scratch/from-host.txt" }, undefined);
		assert.match(textOf(result), /host-wrote-this/);
	});

	await test("read handles binary files byte-exactly", async () => {
		const ops = createContainerReadOps(target);
		const [containerBytes, hostHash] = await Promise.all([
			ops.readFile("/usr/bin/grep"),
			containerExec(target, ["sha256sum", "/usr/bin/grep"]).then((r) => r.stdout.toString().split(" ")[0]),
		]);
		const { createHash } = await import("node:crypto");
		assert.strictEqual(createHash("sha256").update(containerBytes).digest("hex"), hostHash);
	});

	await test("ls lists container directory entries", async () => {
		const result = await lsTool.execute("t", { path: ".dc-test-scratch" }, undefined);
		const output = textOf(result);
		assert.match(output, /hello\.txt/);
		assert.match(output, /from-host\.txt/);
	});

	await test("ls handles filenames with spaces", async () => {
		await containerExec(target, ["touch", `${target.containerWorkspace}/.dc-test-scratch/two words.txt`]);
		const result = await lsTool.execute("t", { path: ".dc-test-scratch" }, undefined);
		assert.match(textOf(result), /two words\.txt/);
	});

	await test("ls rejects a path that does not exist in the container", async () => {
		await assert.rejects(() => lsTool.execute("t", { path: ".dc-test-scratch/missing-dir" }, undefined));
	});

	await test("find matches files by glob inside the container", async () => {
		mkdirSync(path.join(SCRATCH, "nested"), { recursive: true });
		writeFileSync(path.join(SCRATCH, "nested", "deep.ts"), "export const x = 1;\n");
		const result = await findTool.execute("t", { pattern: "*.ts", path: ".dc-test-scratch" }, undefined);
		assert.match(textOf(result), /nested\/deep\.ts/);
	});

	await test("find supports path-shaped globs", async () => {
		const result = await findTool.execute("t", { pattern: "nested/*.ts", path: ".dc-test-scratch" }, undefined);
		assert.match(textOf(result), /nested\/deep\.ts/);
	});

	await test("find reports no matches cleanly", async () => {
		const result = await findTool.execute("t", { pattern: "*.zzz", path: ".dc-test-scratch" }, undefined);
		assert.match(textOf(result), /No files found/);
	});

	console.log("\n--- routed grep ---");

	writeFileSync(
		path.join(SCRATCH, "grep-target.txt"),
		["alpha line", "beta NEEDLE here", "gamma line", "delta NEEDLE again", "epsilon"].join("\n") + "\n",
	);

	await test("grep finds matches with file and line numbers", async () => {
		const result = await executeContainerGrep(
			target,
			{ pattern: "NEEDLE", path: ".dc-test-scratch" },
			{ hasRipgrep },
		);
		const output = textOf(result);
		assert.match(output, /grep-target\.txt:2: beta NEEDLE here/);
		assert.match(output, /grep-target\.txt:4: delta NEEDLE again/);
	});

	await test("grep includes context lines when requested", async () => {
		const result = await executeContainerGrep(
			target,
			{ pattern: "delta NEEDLE", path: ".dc-test-scratch", context: 1 },
			{ hasRipgrep },
		);
		const output = textOf(result);
		assert.match(output, /grep-target\.txt-3- gamma line/, "context line before");
		assert.match(output, /grep-target\.txt:4: delta NEEDLE again/, "match line");
		assert.match(output, /grep-target\.txt-5- epsilon/, "context line after");
	});

	await test("grep honors ignoreCase", async () => {
		const sensitive = await executeContainerGrep(
			target,
			{ pattern: "needle", path: ".dc-test-scratch" },
			{ hasRipgrep },
		);
		assert.match(textOf(sensitive), /No matches found/);
		const insensitive = await executeContainerGrep(
			target,
			{ pattern: "needle", path: ".dc-test-scratch", ignoreCase: true },
			{ hasRipgrep },
		);
		assert.match(textOf(insensitive), /beta NEEDLE here/);
	});

	await test("grep honors literal mode for regex metacharacters", async () => {
		writeFileSync(path.join(SCRATCH, "literal.txt"), "cost is a.b dollars\ncost is axb dollars\n");
		const regexResult = await executeContainerGrep(
			target,
			{ pattern: "a.b", path: ".dc-test-scratch/literal.txt" },
			{ hasRipgrep },
		);
		assert.match(textOf(regexResult), /axb/, "regex mode should match a.b as a wildcard");
		const literalResult = await executeContainerGrep(
			target,
			{ pattern: "a.b", path: ".dc-test-scratch/literal.txt", literal: true },
			{ hasRipgrep },
		);
		const literalText = textOf(literalResult);
		assert.match(literalText, /a\.b/);
		assert.ok(!literalText.includes("axb"), "literal mode must not match axb");
	});

	await test("grep honors the glob filter", async () => {
		const result = await executeContainerGrep(
			target,
			{ pattern: "NEEDLE", path: ".dc-test-scratch", glob: "*.md" },
			{ hasRipgrep },
		);
		assert.match(textOf(result), /No matches found/);
	});

	await test("grep enforces the match limit with a notice", async () => {
		const many = Array.from({ length: 40 }, (_, i) => `line ${i} REPEATED`).join("\n");
		writeFileSync(path.join(SCRATCH, "many.txt"), `${many}\n`);
		const result = await executeContainerGrep(
			target,
			{ pattern: "REPEATED", path: ".dc-test-scratch", limit: 5 },
			{ hasRipgrep },
		);
		const output = textOf(result);
		const matchLines = output.split("\n").filter((line) => line.includes("REPEATED"));
		assert.strictEqual(matchLines.length, 5, `expected 5 matches, got ${matchLines.length}`);
		assert.match(output, /5 matches limit reached/);
		assert.strictEqual(result.details?.matchLimitReached, 5);
	});

	await test("grep returns a clean message when nothing matches", async () => {
		const result = await executeContainerGrep(
			target,
			{ pattern: "zzz-not-present-zzz", path: ".dc-test-scratch" },
			{ hasRipgrep },
		);
		assert.strictEqual(textOf(result), "No matches found");
		assert.strictEqual(result.details, undefined);
	});

	await test("grep rejects a missing search path", async () => {
		await assert.rejects(() =>
			executeContainerGrep(target, { pattern: "x", path: ".dc-test-scratch/missing" }, { hasRipgrep }),
		);
	});

	console.log("\n--- cancellation and timeouts ---");

	// The built-in bash tool signals these by throwing; pi turns that into isError.
	await test("bash surfaces a timeout", async () => {
		const started = Date.now();
		await assert.rejects(
			() => bashTool.execute("t", { command: "sleep 30", timeout: 1 }, undefined),
			/timed out after 1 seconds/,
		);
		assert.ok(Date.now() - started < 15_000, "should stop at the timeout, not run to completion");
	});

	await test("bash aborts when the signal fires", async () => {
		const controller = new AbortController();
		const started = Date.now();
		setTimeout(() => controller.abort(), 300);
		await assert.rejects(
			() => bashTool.execute("t", { command: "sleep 30" }, controller.signal),
			/aborted/i,
		);
		assert.ok(Date.now() - started < 15_000, "abort should be prompt");
	});

	await test("bash reports non-zero exit codes", async () => {
		await assert.rejects(() => bashTool.execute("t", { command: "exit 3" }, undefined), /exit(ed)? .*3/);
	});

	await test("aborting bash kills the process inside the container", async () => {
		const marker = `pi-abort-probe-${Date.now()}`;
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 500);
		await assert.rejects(() => bashTool.execute("t", { command: `sleep 45 # ${marker}` }, controller.signal));
		await new Promise((resolve) => setTimeout(resolve, 500));
		const check = await containerExec(target, ["sh", "-c", `ps -ef | grep -c "[${marker.slice(0, 1)}]${marker.slice(1)}"`]);
		assert.strictEqual(check.stdout.toString().trim(), "0", "no orphaned process should remain");
	});

	await test("bash streams stderr as well as stdout", async () => {
		const result = await bashTool.execute("t", { command: "echo out; echo err 1>&2" }, undefined);
		const output = textOf(result);
		assert.match(output, /out/);
		assert.match(output, /err/);
	});

	rmSync(SCRATCH, { recursive: true, force: true });

	console.log(`\n${failed === 0 ? "ALL TESTS PASSED" : "SOME TESTS FAILED"}: ${passed} passed, ${failed} failed\n`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
