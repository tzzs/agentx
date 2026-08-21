import { emitKeypressEvents } from "node:readline";
import { stdin as input } from "node:process";

let refs = 0;

/**
 * Reference-counted raw-mode session for the shared stdin.
 *
 * The launcher and its nested pickers / secret prompts all operate on the same
 * stdin stream. Each one calls enterRawMode() on entry and exitRawMode() on
 * exit; only the first enter sets up the session and only the last exit tears
 * it down. This keeps nested interactions from pausing the stream out from
 * under their caller.
 */
export function enterRawMode(): void {
  if (refs++ === 0) {
    emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    input.resume();
  }
}

export function exitRawMode(): void {
  if (--refs === 0) {
    input.pause();
    if (input.isTTY) input.setRawMode(false);
  }
}
