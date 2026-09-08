/**
 * Exits 0 and prints the container name when this repository's devcontainer is
 * running, otherwise exits 1. Used by `devenv test` to decide whether the
 * container integration suites can run.
 *
 * Needs no pi packages and no container runtime to execute.
 */

import path from "node:path";
import { detectRuntimes, findRunningContainer } from "../src/container.ts";
import { findDevcontainerConfig } from "../src/discovery.ts";

const root = path.resolve(import.meta.dirname, "..");
const devcontainer = findDevcontainerConfig(root);
if (!devcontainer) {
	console.error("no devcontainer.json found for this repository");
	process.exit(1);
}

const runtimes = await detectRuntimes();
if (runtimes.length === 0) {
	console.error("no container runtime (docker or podman) available");
	process.exit(1);
}

const target = await findRunningContainer(runtimes, devcontainer);
if (!target) {
	console.error(`no running container for ${devcontainer.workspaceFolder}`);
	process.exit(1);
}

console.log(target.name);
