import { expect, spyOn, test } from "bun:test";
import type { LiveEvent, SessionEvent } from "@pipoca/protocol";
import { sessionChannel } from "./session-channel";

const entry = (line: number): SessionEvent => ({
  type: "entry",
  line,
  entry: "{}",
});

const live = (event: LiveEvent): SessionEvent => ({ type: "live", event });

const changes = (data: unknown): SessionEvent =>
  live({ type: "plugin", plugin: "changes", key: "changes", data });

test("a late listener gets the stream so far, as a reconnect would replay it", () => {
  const channel = sessionChannel("s");

  [
    entry(0),
    changes([1]),
    live({ type: "text", delta: "hel" }),
    entry(1),
    changes([2]),
    live({ type: "extension_status", key: "k", text: "busy" }),
    live({ type: "extension_status", key: "k", text: null }),
  ].forEach(channel.dispatch);

  const seen: SessionEvent[] = [];
  channel.session.events((event) => seen.push(event));

  expect(seen).toEqual([entry(0), entry(1), changes([2])]);

  channel.dispatch(entry(2));

  expect(seen.at(-1)).toEqual(entry(2));
});

test("a listener that throws doesn't keep the event from the others", () => {
  const channel = sessionChannel("s");

  const logged = spyOn(globalThis, "reportError").mockImplementation(
    () => undefined,
  );

  const seen: SessionEvent[] = [];

  try {
    channel.session.events(() => {
      throw new Error("plugin bug");
    });

    channel.session.events((event) => seen.push(event));

    expect(() => {
      channel.dispatch(entry(0));
    }).not.toThrow();

    expect(seen).toEqual([entry(0)]);
    expect(logged).toHaveBeenCalled();
  } finally {
    logged.mockRestore();
  }
});
