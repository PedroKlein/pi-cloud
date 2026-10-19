import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { Command, LiveEvent } from "@pi-cloud/protocol";
import { hostSession, type SessionStream } from "./index";
import { fauxModels } from "./testdata/models";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sessionhost-host-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fakeStream(options: { failUploads?: number } = {}): {
  stream: SessionStream;
  send: (command: Command) => void;
  events: LiveEvent[];
  lines: string[];
  uploads: number[];
  waitFor: (predicate: () => boolean) => Promise<void>;
} {
  let failures = options.failUploads ?? 0;
  let listener: ((command: Command) => void) | undefined;
  const events: LiveEvent[] = [];
  const lines: string[] = [];
  const uploads: number[] = [];
  const stream: SessionStream = {
    uploadTranscript: async (start, batch) => {
      await Promise.resolve();
      uploads.push(start);
      if (failures > 0) {
        failures--;
        throw new Error("server unavailable");
      }
      lines.splice(start, batch.length, ...batch);
      return lines.length;
    },
    publish: async (batch) => {
      await Promise.resolve();
      events.push(...batch);
    },
    commands: (l) => {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
  };
  return {
    stream,
    send: (command) => listener?.(command),
    events,
    lines,
    uploads,
    waitFor: async (predicate) => {
      while (!predicate()) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

function roles(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    const entry = JSON.parse(line) as { message?: { role: string } };
    return entry.message?.role ?? [];
  });
}

test("streams a turn as live events and transcript lines", async () => {
  const { faux, models } = await fauxModels(root);
  faux.setResponses([fauxAssistantMessage([fauxText("hello back")])]);
  const fake = fakeStream();

  const hosted = await hostSession(
    {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models,
    },
    fake.stream,
    () => undefined,
  );
  fake.send({ type: "message", text: "hello" });
  await fake.waitFor(() => roles(fake.lines).includes("assistant"));
  await hosted.stop();

  const text = fake.events
    .flatMap((e) => (e.type === "text" ? e.delta : []))
    .join("");
  expect(text).toBe("hello back");
  expect(fake.events.filter((e) => e.type === "status")).toEqual([
    { type: "status", status: "idle" },
    { type: "status", status: "running" },
    { type: "status", status: "idle" },
  ]);
  expect(roles(fake.lines).slice(-2)).toEqual(["user", "assistant"]);
});

test("resends the transcript from the last acknowledged line after a failure", async () => {
  const { faux, models } = await fauxModels(root);
  faux.setResponses([fauxAssistantMessage([fauxText("hi")])]);
  const fake = fakeStream({ failUploads: 1 });
  const logs: string[] = [];

  const hosted = await hostSession(
    {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      extensionPaths: [],
      models,
    },
    fake.stream,
    (message) => logs.push(message),
  );
  fake.send({ type: "message", text: "hello" });
  await fake.waitFor(() => roles(fake.lines).includes("assistant"));
  await hosted.stop();

  expect(logs).toContain("transcript upload failed");
  expect(fake.uploads[0]).toBe(0);
  expect(fake.uploads[1]).toBe(0);
  expect(roles(fake.lines).slice(-2)).toEqual(["user", "assistant"]);
});
