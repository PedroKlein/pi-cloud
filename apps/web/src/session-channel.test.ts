import { expect, test } from "bun:test";
import type { LiveEvent, SessionEvent } from "@pi-cloud/protocol";
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
