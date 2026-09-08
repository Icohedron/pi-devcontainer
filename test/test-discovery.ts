/**
 * Unit tests for devcontainer discovery and JSONC parsing.
 *
 * These need no container runtime and no pi packages, so they run anywhere,
 * including inside the devcontainer itself (`devenv test`).
 *
 * Usage: node test/test-discovery.ts
 */

import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findDevcontainerConfig, parseJsonc } from "../src/discovery.ts";

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

async function main(): Promise<void> {
	console.log("\n--- discovery ---");

	await test("finds devcontainer.json from the project root", () => {
		const found = findDevcontainerConfig(PROJECT);
		assert.ok(found, "expected a config");
		assert.strictEqual(found.configPath, path.join(PROJECT, ".devcontainer", "devcontainer.json"));
		assert.strictEqual(found.workspaceFolder, PROJECT);
	});

	await test("walks up from a nested subdirectory", () => {
		const nested = path.join(PROJECT, "src");
		const found = findDevcontainerConfig(nested);
		assert.ok(found);
		assert.strictEqual(found.workspaceFolder, PROJECT, "should resolve to the parent holding .devcontainer");
	});

	await test("returns null when no devcontainer exists above the directory", () => {
		assert.strictEqual(findDevcontainerConfig("/proc"), null);
	});

	await test("picks the nearest config when nested devcontainers exist", () => {
		const inner = path.join(SCRATCH, "inner");
		mkdirSync(path.join(inner, ".devcontainer"), { recursive: true });
		writeFileSync(path.join(inner, ".devcontainer", "devcontainer.json"), '{"name":"inner"}');
		try {
			const found = findDevcontainerConfig(path.join(inner, "deep", "deeper"));
			assert.ok(found);
			assert.strictEqual(found.workspaceFolder, inner, "nearest config must win over the outer one");
		} finally {
			rmSync(SCRATCH, { recursive: true, force: true });
		}
	});

	await test("reads remoteUser out of the discovered config", () => {
		const found = findDevcontainerConfig(PROJECT);
		assert.ok(found);
		assert.strictEqual(typeof found.config, "object");
	});

	console.log("\n--- JSONC parsing ---");

	await test("parses JSONC with comments and trailing commas", () => {
		const parsed = parseJsonc(`{
			// line comment
			"image": "ubuntu", /* block */
			"remoteUser": "vscode", // trailing comma next
		}`);
		assert.strictEqual(parsed.image, "ubuntu");
		assert.strictEqual(parsed.remoteUser, "vscode");
	});

	await test("keeps comment-like sequences inside strings", () => {
		const parsed = parseJsonc('{"url": "https://example.com//x", "p": "a/*b*/c"}');
		assert.strictEqual(parsed.url, "https://example.com//x");
		assert.strictEqual(parsed.p, "a/*b*/c");
	});

	await test("parses the repository's own devcontainer.json", () => {
		const found = findDevcontainerConfig(PROJECT);
		assert.ok(found);
		assert.ok(Object.keys(found.config).length > 0, "expected parsed keys from devcontainer.json");
	});

	console.log(`\n${failed === 0 ? "ALL TESTS PASSED" : "SOME TESTS FAILED"}: ${passed} passed, ${failed} failed\n`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
