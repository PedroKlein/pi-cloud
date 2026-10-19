import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { openTerminal } from "./index";

function collect(): {
  onData: (data: Uint8Array) => void;
  waitFor: (text: string) => Promise<void>;
} {
  const decoder = new TextDecoder();
  let output = "";
  let waiting: { text: string; resolve: () => void } | undefined;

  return {
    onData(data) {
      output += decoder.decode(data, { stream: true });
      if (waiting && output.includes(waiting.text)) {
        waiting.resolve();
      }
    },
    async waitFor(text) {
      if (output.includes(text)) {
        return;
      }

      await new Promise<void>((resolve) => {
        waiting = { text, resolve };
      });
    },
  };
}

test("runs commands in an interactive shell and follows resizes", async () => {
  const output = collect();

  const terminal = openTerminal(
    { cwd: tmpdir(), shell: "/bin/sh", cols: 80, rows: 24 },
    output.onData,
  );

  terminal.write("echo $((6 * 7))-answer\n");
  await output.waitFor("42-answer");

  terminal.resize(120, 40);
  terminal.write("stty size\n");
  await output.waitFor("40 120");

  terminal.write("exit 3\n");
  expect(await terminal.exited).toBe(3);
});

test("close ends the shell", async () => {
  const terminal = openTerminal(
    { cwd: tmpdir(), shell: "/bin/sh", cols: 80, rows: 24 },
    () => undefined,
  );

  terminal.close();

  expect(await terminal.exited).not.toBe(0);
});
