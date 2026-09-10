/**
 * The progress line for the work that happens before a session or a command
 * can continue.
 *
 * Container lookups are not instant. Rootless podman takes most of a second to
 * answer, and a lookup happens at the start of a session and again for each
 * `/devcontainer` command that examines the container. Without a message, that
 * time looks like a delay with no cause.
 *
 * The line uses the Loader component of pi, so the animation is the same one
 * that pi shows for "Working".
 *
 * A short delay comes before the line. Most lookups are quicker than the delay,
 * and a line that comes and goes in 100 ms is more of a distraction than a
 * help.
 */

import { Loader } from "@earendil-works/pi-tui";

/** Widget key. It is not the status key, which shows the routing. */
export const PROGRESS_KEY = "devcontainer:progress";

/** Time before the line becomes visible. */
export const PROGRESS_DELAY_MS = 250;

/** The parts of the theme of pi that the line uses. */
export interface ProgressTheme {
	fg(color: string, text: string): string;
}

/** The parts of the user interface of pi that the line uses. */
export interface ProgressUI {
	setWidget?: (key: string, content: unknown, options?: unknown) => void;
}

/** The parts of the TUI of pi that the Loader uses. */
export interface ProgressTui {
	requestRender(): void;
}

/**
 * Make the component factory for the line.
 *
 * pi calls the factory with its TUI and its theme, and calls dispose() when the
 * widget goes away. dispose() stops the animation timer.
 */
export function createProgressWidget(message: string) {
	return (tui: ProgressTui, theme: ProgressTheme) => {
		const loader = new Loader(
			tui as never,
			(text: string) => theme.fg("accent", text),
			(text: string) => theme.fg("muted", text),
			message,
		);
		return Object.assign(loader, { dispose: () => loader.stop() });
	};
}

/**
 * Show the line, and give back the function that removes it.
 *
 * The function is safe to call more than one time. If the work stops before the
 * delay, the line does not become visible, and the user interface gets no call.
 */
export function showProgress(
	ui: ProgressUI | undefined,
	message: string,
	delayMs: number = PROGRESS_DELAY_MS,
): () => void {
	const setWidget = ui?.setWidget;
	if (!setWidget) return () => {};

	let visible = false;
	let stopped = false;
	const timer = setTimeout(() => {
		if (stopped) return;
		visible = true;
		setWidget.call(ui, PROGRESS_KEY, createProgressWidget(message));
	}, delayMs);
	// The timer must not keep the process alive if the session stops first.
	timer.unref?.();

	return () => {
		if (stopped) return;
		stopped = true;
		clearTimeout(timer);
		if (visible) setWidget.call(ui, PROGRESS_KEY, undefined);
	};
}

/** Show the line for the time that the work takes. */
export async function withProgress<T>(
	ui: ProgressUI | undefined,
	message: string,
	work: () => Promise<T>,
	delayMs?: number,
): Promise<T> {
	const stop = showProgress(ui, message, delayMs);
	try {
		return await work();
	} finally {
		stop();
	}
}
