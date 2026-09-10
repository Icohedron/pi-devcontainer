/**
 * Tests for the progress line.
 *
 * The line must appear when a lookup is slow, must not appear when it is
 * quick, and must always go away. A progress indicator that stays on the
 * screen is worse than none.
 *
 * Needs no container. Needs the pi packages, for the Loader component.
 *
 * Usage: node test/test-progress.ts
 */

import assert from "node:assert";
import { createProgressWidget, PROGRESS_DELAY_MS, PROGRESS_KEY, showProgress, withProgress } from "../src/progress.ts";

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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A user interface that records what the extension asks it to show. */
function fakeUI() {
	const calls: Array<{ key: string; content: unknown }> = [];
	return {
		calls,
		setWidget(key: string, content: unknown) {
			calls.push({ key, content });
		},
		get shown() {
			return calls.filter((call) => call.content !== undefined).length;
		},
		get cleared() {
			return calls.filter((call) => call.content === undefined).length;
		},
	};
}

const theme = { fg: (_color: string, text: string) => text };
const tui = { requestRender() {} };

async function main(): Promise<void> {
	console.log("\n--- when the line appears ---");

	await test("work that is quicker than the delay shows nothing", async () => {
		const ui = fakeUI();
		await withProgress(ui, "Looking", async () => wait(5), 40);
		assert.deepStrictEqual(ui.calls, [], "a line that comes and goes is a distraction");
	});

	await test("work that is slower than the delay shows the line, then removes it", async () => {
		const ui = fakeUI();
		await withProgress(ui, "Looking", async () => wait(80), 20);
		assert.strictEqual(ui.shown, 1);
		assert.strictEqual(ui.cleared, 1);
		assert.strictEqual(ui.calls[0].key, PROGRESS_KEY);
		assert.strictEqual(ui.calls.at(-1)?.content, undefined, "the last call must remove the line");
	});

	await test("the line goes away when the work fails", async () => {
		const ui = fakeUI();
		await assert.rejects(
			withProgress(
				ui,
				"Looking",
				async () => {
					await wait(60);
					throw new Error("no container");
				},
				20,
			),
			/no container/,
		);
		assert.strictEqual(ui.cleared, 1, "an error must not leave the line on the screen");
	});

	await test("the stop function is safe to call more than one time", async () => {
		const ui = fakeUI();
		const stop = showProgress(ui, "Looking", 20);
		await wait(60);
		stop();
		stop();
		assert.strictEqual(ui.cleared, 1);
	});

	await test("a user interface with no widgets is safe", async () => {
		const result = await withProgress(undefined, "Looking", async () => "done", 5);
		assert.strictEqual(result, "done");
		const stop = showProgress({}, "Looking", 5);
		stop();
	});

	await test("the delay is short, but long enough to hide a quick lookup", () => {
		assert.ok(PROGRESS_DELAY_MS >= 100 && PROGRESS_DELAY_MS <= 500, `${PROGRESS_DELAY_MS}ms is not a good delay`);
	});

	console.log("\n--- what the line shows ---");

	await test("the line has an animated indicator and the message", async () => {
		const widget = createProgressWidget("Looking for the devcontainer")(tui, theme);
		try {
			const first = widget.render(60).join("").trim();
			assert.match(first, /Looking for the devcontainer$/);

			const frames = new Set<string>();
			for (let index = 0; index < 12; index++) {
				frames.add(widget.render(60).join("").trim().split(" ")[0]);
				await wait(85);
			}
			assert.ok(frames.size > 1, `the indicator does not move: ${[...frames].join("")}`);
		} finally {
			widget.dispose();
		}
	});

	await test("dispose stops the animation", async () => {
		const widget = createProgressWidget("Looking")(tui, theme);
		widget.dispose();
		const after = widget.render(60).join("");
		await wait(200);
		assert.strictEqual(widget.render(60).join(""), after, "a disposed line must not keep the timer");
	});

	await test("the indicator is the one that pi uses for its own work", async () => {
		// The same braille frames as the "Working" line of pi.
		const widget = createProgressWidget("Looking")(tui, theme);
		try {
			const frames = new Set<string>();
			for (let index = 0; index < 12; index++) {
				frames.add(widget.render(40).join("").trim().split(" ")[0]);
				await wait(85);
			}
			for (const frame of frames) {
				assert.match(frame, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, `${frame} is not a frame of the pi indicator`);
			}
		} finally {
			widget.dispose();
		}
	});

	console.log(`\n${failed === 0 ? "ALL TESTS PASSED" : "SOME TESTS FAILED"}: ${passed} passed, ${failed} failed\n`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
