import { expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ok, watchChanges } from "./index";

test("ok accepts an empty success and rejects with the server's error", async () => {
  const empty = new Response(null, { status: 204 });

  expect(await ok(Promise.resolve(empty))).toBe(empty);

  const refused = Response.json({ error: "unknown state" }, { status: 400 });

  expect(await ok(Promise.resolve(refused)).catch(String)).toBe(
    "Error: unknown state",
  );
});

class FakeStream {
  static opened: FakeStream[] = [];
  readyState = 1;
  closed = false;
  readonly listeners = new Map<string, ((event: { data: string }) => void)[]>();

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeStream.opened.push(this);
  }

  addEventListener(
    type: string,
    listener: (event: { data: string }) => void,
  ): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data = ""): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data });
    }
  }

  close(): void {
    this.closed = true;
  }
}

test("watchChanges fetches once per burst of its topics and again after a reconnect", async () => {
  const globals = globalThis as unknown as { EventSource: unknown };
  const original = globals.EventSource;
  globals.EventSource = FakeStream;

  try {
    let sessions = 0;
    let profiles = 0;

    const unwatchSessions = watchChanges(["sessions"], () => {
      sessions++;
    });

    const unwatchProfiles = watchChanges(["profiles"], () => {
      profiles++;
    });

    expect(FakeStream.opened.map(({ url }) => url)).toEqual(["/api/changes"]);
    const [stream] = FakeStream.opened;

    stream?.emit("message", JSON.stringify({ topic: "sessions" }));
    stream?.emit("message", JSON.stringify({ topic: "sessions" }));
    await sleep(300);

    expect({ sessions, profiles }).toEqual({ sessions: 1, profiles: 0 });

    stream?.emit("error");
    stream?.emit("open");
    await sleep(300);

    expect({ sessions, profiles }).toEqual({ sessions: 2, profiles: 1 });

    unwatchSessions();
    unwatchProfiles();

    expect(stream?.closed).toBe(true);
  } finally {
    globals.EventSource = original;
  }
});

test("watchChanges fetches again after an error response closed the stream", async () => {
  const globals = globalThis as unknown as { EventSource: unknown };
  const original = globals.EventSource;
  globals.EventSource = FakeStream;
  FakeStream.opened = [];

  try {
    let sessions = 0;

    const unwatch = watchChanges(["sessions"], () => {
      sessions++;
    });

    const [refused] = FakeStream.opened;

    if (refused !== undefined) {
      refused.readyState = 2;
    }

    refused?.emit("error");
    await sleep(1100);

    expect(FakeStream.opened).toHaveLength(2);

    FakeStream.opened[1]?.emit("open");
    await sleep(300);

    expect(sessions).toBe(1);

    unwatch();
  } finally {
    globals.EventSource = original;
  }
});

test("watchChanges reloads the page instead of reconnecting once the browser is signed out", async () => {
  const globals = globalThis as unknown as {
    EventSource: unknown;
    location?: unknown;
  };

  const original = globals.EventSource;
  const realFetch = globalThis.fetch;
  let reloads = 0;
  globals.EventSource = FakeStream;
  globals.location = { reload: () => reloads++ };

  globalThis.fetch = Object.assign(
    async () =>
      Promise.resolve(Response.json({ error: "signed_out" }, { status: 401 })),
    { preconnect: realFetch.preconnect },
  );

  try {
    FakeStream.opened = [];
    const unwatch = watchChanges(["sessions"], () => undefined);
    const [stream] = FakeStream.opened;

    if (stream !== undefined) {
      stream.readyState = 2;
    }

    stream?.emit("error");
    await sleep(1100);

    expect({ reloads, streams: FakeStream.opened.length }).toEqual({
      reloads: 1,
      streams: 1,
    });

    unwatch();
  } finally {
    globals.EventSource = original;
    globalThis.fetch = realFetch;
    delete globals.location;
  }
});
