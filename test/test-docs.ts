/**
 * Documentation tests.
 *
 * The settings surface is the part most likely to drift: a key added in code
 * and forgotten in the README is invisible until someone needs it. These tests
 * compare the two directly, so the docs fail the build rather than the user.
 *
 * Needs no container and no pi packages.
 *
 * Usage: node test/test-docs.ts
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG, PROJECT_SAFE_KEYS, ROUTABLE_TOOLS } from "../src/config.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const readme = readFileSync(path.join(REPO, "README.md"), "utf8");
const configSource = readFileSync(path.join(REPO, "src", "config.ts"), "utf8");

/** The keys applyLayer accepts, read from the source rather than duplicated. */
const KNOWN_KEYS = [...configSource.matchAll(/^\t"([a-zA-Z]+)",$/gm)].map((match) => match[1]);

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void): Promise<void> {
	try {
		fn();
		passed++;
		console.log(`  PASS  ${name}`);
	} catch (error) {
		failed++;
		console.log(`  FAIL  ${name}`);
		console.log(`        ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function main(): Promise<void> {
	console.log("\n--- settings are documented ---");

	await test("the source really does define every known key", () => {
		assert.ok(KNOWN_KEYS.length >= 10, `only found ${KNOWN_KEYS.length} keys; the parser may have broken`);
		for (const key of Object.keys(DEFAULT_CONFIG)) {
			assert.ok(KNOWN_KEYS.includes(key), `${key} has a default but is not accepted`);
		}
	});

	for (const key of KNOWN_KEYS) {
		await test(`${key} has a row in the settings table`, () => {
			assert.match(readme, new RegExp(`^\\| \`${key}\``, "m"), `no table row for ${key}`);
		});
	}

	await test("every key appears in the all-keys example", () => {
		for (const key of KNOWN_KEYS) {
			assert.match(readme, new RegExp(`"${key}"\\s*:`), `${key} is missing from the example block`);
		}
	});

	await test("every key documents its default", () => {
		const rows = new Map(
			[...readme.matchAll(/^\| `([a-zA-Z]+)` \|(.*)$/gm)].map((match) => [match[1], match[2]]),
		);
		for (const key of KNOWN_KEYS) {
			const row = rows.get(key) ?? "";
			assert.match(row, /Default/i, `the row for ${key} does not state a default`);
		}
	});

	console.log("\n--- documented scope matches the code ---");

	await test("the README names exactly the keys a project may set", () => {
		const safe = [...PROJECT_SAFE_KEYS];
		assert.deepStrictEqual(safe, ["enabled"], "update the README if this changes");
		assert.match(readme, /`enabled` only/, "the scope table should say what a project may set");
		assert.ok(
			!/Project settings win key by key/.test(readme),
			"stale: projects cannot override arbitrary keys",
		);
	});

	await test("the routable tool list matches the documented default", () => {
		assert.match(readme, /Default all seven/, "the tools row should state the default");
		assert.strictEqual(ROUTABLE_TOOLS.length, 7, "seven is no longer the right number in the README");
		for (const tool of ROUTABLE_TOOLS) {
			assert.match(readme, new RegExp(`\`${tool}\``), `${tool} is not mentioned anywhere`);
		}
	});

	console.log("\n--- documented strings match the code ---");

	await test("footer strings in the README are the ones the code produces", () => {
		// Compare shapes: drop interpolations and sample names, collapse spacing.
		const shape = (text: string) =>
			text
				.replace(/\$\{[^}]*\}/g, "")
				.replace(/nifty_hopper|<name>/g, "")
				.replace(/\s+/g, " ")
				.trim();
		const source = readFileSync(path.join(REPO, "src", "index.ts"), "utf8");
		const emitted = new Set(
			[...source.matchAll(/["`](⧉|⚠)([^"`]*)["`]/g)].map((match) => shape(`${match[1]}${match[2]}`)),
		);
		const documented = [...readme.matchAll(/`(⧉|⚠)([^`]*)`/g)].map((match) => `${match[1]}${match[2]}`);
		assert.ok(documented.length > 0, "the README should show the footer strings");
		for (const shown of documented) {
			assert.ok(
				emitted.has(shape(shown)),
				`README shows ${JSON.stringify(shown)}, which the code never produces. Emitted: ${[...emitted].join(" | ")}`,
			);
		}
	});

	await test("the CLI flag is documented", () => {
		const source = readFileSync(path.join(REPO, "src", "index.ts"), "utf8");
		const flags = [...source.matchAll(/registerFlag\("([a-z-]+)"/g)].map((match) => match[1]);
		for (const flag of flags) {
			assert.match(readme, new RegExp(`--${flag}`), `--${flag} is not documented`);
		}
	});

	await test("every command argument is documented", () => {
		const source = readFileSync(path.join(REPO, "src", "index.ts"), "utf8");
		const actions = [...source.matchAll(/action === "([a-z]+)"/g)].map((match) => match[1]);
		for (const action of new Set(actions)) {
			// Either spelled out as a command, or named as an accepted alias.
			const documented =
				new RegExp(`/(dc|devcontainer) ${action}`).test(readme) ||
				new RegExp("`" + action + "`[^\\n]*spelling", "i").test(readme) ||
				new RegExp("spellings[^\\n]*`" + action + "`", "i").test(readme);
			assert.ok(documented, `the ${action} argument is not documented`);
		}
	});

	console.log(`\n${failed === 0 ? "ALL TESTS PASSED" : "SOME TESTS FAILED"}: ${passed} passed, ${failed} failed\n`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
