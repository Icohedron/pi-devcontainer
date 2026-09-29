import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { containerBashExec, type ContainerTarget } from "../src/container.ts";

// A container CLI can exit while the command it launched keeps running. This
// stand-in deliberately leaves the remote process alone when its client dies.
const dir = mkdtempSync(path.join(tmpdir(), "dc-cancel-"));
const runtime = path.join(dir, "runtime");
writeFileSync(runtime, `#!/bin/sh
[ "$1" = exec ] || exit 2
shift
while [ "$1" = -w ] || [ "$1" = --user ] || [ "$1" = -i ]; do
  case "$1" in -i) shift ;; *) shift 2 ;; esac
done
shift # container id
setsid "$@" &
wait $!
`);
chmodSync(runtime, 0o755);
const target: ContainerTarget = {
	runtime: { bin: runtime, args: [], execArgs: [] },
	id: "test-container", name: "test-container", shell: "sh", hasRipgrep: false,
	hostWorkspace: dir, containerWorkspace: dir, configPath: "test",
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
	const normalOutput: string[] = [];
	const normal = await containerBashExec(target, "sh", "printf 'hello\\n'", {
		cwd: dir, onData: (chunk) => normalOutput.push(chunk.toString()),
	});
	assert.equal(normal.exitCode, 0);
	assert.equal(normalOutput.join(""), "hello\n", "the PID handshake must not reach tool output");
	console.log("PASS ordinary bash output is unchanged");

	const marker = path.join(dir, "finished");
	const controller = new AbortController();
	let output = "";
	const execution = containerBashExec(target, "sh", `printf 'ready\\n'; sleep 0.5; printf done > '${marker}'`, {
		cwd: dir, signal: controller.signal,
		onData: (chunk) => {
			output += chunk.toString();
			if (output.includes("ready")) controller.abort();
		},
	});
	await assert.rejects(execution, /aborted/);
	await delay(700);
	assert.equal(existsSync(marker), false, "interrupted command must not continue inside the container");
	console.log("PASS Esc/abort stops the in-container shell before its delayed side effect");

	// Esc may arrive before the container has even printed its process ID.
	const earlyMarker = path.join(dir, "early-finished");
	const early = new AbortController();
	const earlyExecution = containerBashExec(target, "sh", `sleep 0.5; printf done > '${earlyMarker}'`, {
		cwd: dir, signal: early.signal,
	});
	early.abort();
	await assert.rejects(earlyExecution, /aborted/);
	await delay(700);
	assert.equal(existsSync(earlyMarker), false, "early cancellation must not strand the remote command");
	console.log("PASS abort during startup also stops the remote command");

	const childMarker = path.join(dir, "child-finished");
	const childAbort = new AbortController();
	let childOutput = "";
	const withChild = containerBashExec(target, "sh",
		`(sleep 0.5; printf done > '${childMarker}') & printf 'ready\\n'; wait`, {
			cwd: dir, signal: childAbort.signal,
			onData: (chunk) => {
				childOutput += chunk.toString();
				if (childOutput.includes("ready")) childAbort.abort();
			},
		});
	await assert.rejects(withChild, /aborted/);
	await delay(700);
	assert.equal(existsSync(childMarker), false, "shell background children must be stopped too");
	console.log("PASS abort stops background children of the in-container shell");

	const timeoutMarker = path.join(dir, "timeout-finished");
	await assert.rejects(containerBashExec(target, "sh", `sleep 0.5; printf done > '${timeoutMarker}'`, {
		cwd: dir, timeout: 0.05,
	}), /timeout:0.05/);
	await delay(700);
	assert.equal(existsSync(timeoutMarker), false, "timed-out command must not continue inside the container");
	console.log("PASS timeout stops the remote command");
} finally {
	rmSync(dir, { recursive: true, force: true });
}
