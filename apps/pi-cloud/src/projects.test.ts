import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProjectView } from "@pi-cloud/projects/model";
import type { Session, ToolSpec } from "@pi-cloud/protocol";
import { serve } from "./serve";

const run = promisify(execFile);

let root: string;
let faux: ReturnType<typeof fauxProvider>;
let server: ReturnType<typeof serve> | undefined;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pi-cloud-projects-")));
  faux = fauxProvider();

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);

  server = serve({
    port: 0,
    database: ":memory:",
    sessions: { pollWaitMs: 100, offlineAfterMs: 1000 },
    agent: {
      provider: "local",
      dataDir: join(root, "local"),
      agentDir: join(root, "pi"),
      extensionPaths: [],
      folders: [],
      models: { runtime, model: faux.getModel() },
    },
    log: () => undefined,
  });
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

async function api(path: string, body?: unknown): Promise<Response> {
  return fetch(new URL(path, server?.url), {
    method: body === undefined ? "GET" : "POST",
    ...(body !== undefined && {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
}

async function repository(name: string): Promise<string> {
  const path = join(root, name);
  await run("git", ["init", "--initial-branch=main", path]);
  await writeFile(join(path, "README.md"), `${name}\n`);
  await run("git", ["add", "."], { cwd: path });

  await run(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "first"],
    { cwd: path },
  );

  return path;
}

async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  for (;;) {
    const value = await read();
    if (done(value)) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function project(id: string): Promise<ProjectView> {
  return (await (
    await api(`/api/plugins/projects/projects/${id}`)
  ).json()) as ProjectView;
}

async function transcript(id: string): Promise<string> {
  const response = await api(`/api/sessions/${id}/events`);
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 300;
  while (reader && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<undefined>((resolve) => setTimeout(resolve, 100)),
    ]);

    if (chunk === undefined || chunk.done) {
      break;
    }

    text += decoder.decode(chunk.value as Uint8Array);
  }

  await reader?.cancel();

  return text;
}

const lastUserText = (
  messages: readonly { role: string; content: unknown }[],
): string =>
  JSON.stringify(
    messages.findLast((message) => message.role !== "assistant") ?? "",
  );

test("runs a Project: a coordinator starts a thread, hears about its turns and shares memory", async () => {
  const a = await repository("app");
  const b = await repository("lib");

  // One reply for every turn, chosen from who asks and what they last saw,
  // since the coordinator and its thread share the faux model's queue.
  const reply = (context: {
    messages: readonly { role: string; content: unknown }[];
  }): AssistantMessage => {
    const coordinator = context.messages.some(
      (message) =>
        message.role === "system" &&
        JSON.stringify(message).includes("You are the coordinator"),
    );

    const last = lastUserText(context.messages);

    if (coordinator && last.includes("plan the release")) {
      return fauxAssistantMessage(
        [
          fauxToolCall("memory_write", {
            name: "MEMORY.md",
            content: "- release is v2",
          }),
          fauxToolCall("start_thread", {
            title: "Bump version",
            message: "bump the version",
            repositories: [b],
            start_points: { [b]: "main" },
          }),
        ],
        { stopReason: "toolUse" },
      );
    }

    if (coordinator && last.includes("need a decision")) {
      return fauxAssistantMessage([fauxText("decided: ship it")]);
    }

    if (coordinator) {
      return fauxAssistantMessage([fauxText("thread started")]);
    }

    if (last.includes("bump the version")) {
      return fauxAssistantMessage(
        [
          fauxToolCall("set_status", { state: "review_ready" }),
          fauxToolCall("message_coordinator", {
            text: "need a decision on the tag",
          }),
        ],
        { stopReason: "toolUse" },
      );
    }

    return fauxAssistantMessage([fauxText("bumped to v2")]);
  };

  faux.setResponses(Array.from({ length: 20 }, () => reply));

  await until(
    async () => (await (await api("/api/environments")).json()) as unknown[],
    (environments) => environments.length > 0,
  );

  const created = await api("/api/plugins/projects/projects", {
    name: "Release",
    instructions: "Keep commits small.",
    repositories: [a, b],
    model: `${faux.getModel().provider}/${faux.getModel().id}`,
  });

  const { id, coordinatorId } = (await created.json()) as ProjectView;

  expect(created.status).toBe(200);

  const coordinator = (await (
    await api(`/api/sessions/${coordinatorId}`)
  ).json()) as Session;

  expect(coordinator.workspace).toMatchObject({
    kind: "repositories",
    repositories: [{ repository: a }, { repository: b }],
  });

  expect(coordinator.systemPrompt).toContain("Keep commits small.");

  expect(coordinator.model).toEqual({
    provider: faux.getModel().provider,
    id: faux.getModel().id,
  });

  await until(
    async () =>
      (await (await api(`/api/sessions/${coordinatorId}`)).json()) as Session,
    (session) => session.status === "idle",
  );

  await api(`/api/sessions/${coordinatorId}/commands`, {
    type: "message",
    text: "plan the release",
  });

  const [thread] = (
    await until(
      async () => project(id),
      (view) => view.threads[0]?.workState === "review_ready",
    )
  ).threads;

  const threadSession = (await (
    await api(`/api/sessions/${thread?.sessionId ?? ""}`)
  ).json()) as Session;

  expect(thread).toMatchObject({ title: "Bump version" });
  expect(threadSession.systemPrompt).toContain("- release is v2");
  expect(threadSession.firstMessage).toBe("bump the version");
  expect(threadSession.model).toEqual(coordinator.model);

  expect(threadSession.workspace).toMatchObject({
    kind: "repositories",
    repositories: [{ repository: b, startPoint: "main" }],
  });

  const notices = await until(
    async () => transcript(coordinatorId),
    (text) =>
      text.includes("decided: ship it") && text.includes("finished a turn"),
  );

  expect(notices).toContain("set its work state to review_ready");
  expect(notices).toContain("bumped to v2");

  const tools = async (sessionId: string): Promise<string[]> =>
    (
      (await (
        await fetch(
          new URL(
            `/agent/sessions/${sessionId}/tools?generation=1`,
            server?.url,
          ),
          {
            headers: { "pi-cloud-protocol": "1", "pi-cloud-provider": "local" },
          },
        )
      ).json()) as ToolSpec[]
    ).map(({ name }) => name);

  expect(await tools(coordinatorId)).toContain("start_thread");
  expect(await tools(coordinatorId)).not.toContain("message_coordinator");
  expect(await tools(thread?.sessionId ?? "")).toContain("message_coordinator");
  expect(await tools(thread?.sessionId ?? "")).not.toContain("start_thread");

  expect((await project(id)).memory).toMatchObject([
    { name: "MEMORY.md", actor: `session:${coordinatorId}` },
  ]);
}, 30_000);

test("wakes the coordinator once for each thread turn", async () => {
  const a = await repository("app");
  const wakes: string[] = [];

  const reply = (context: {
    messages: readonly { role: string; content: unknown }[];
  }): AssistantMessage => {
    const seen = JSON.stringify(context.messages);
    const last = lastUserText(context.messages);

    if (!seen.includes("You are the coordinator")) {
      if (last.includes("count")) {
        return fauxAssistantMessage([fauxText("counted 3")]);
      }

      return last.includes("Message queued")
        ? fauxAssistantMessage([fauxText("read 7")])
        : fauxAssistantMessage(
            [fauxToolCall("message_coordinator", { text: "read 7" })],
            { stopReason: "toolUse" },
          );
    }

    if (last.includes("split the work")) {
      return fauxAssistantMessage(
        [
          fauxToolCall("start_thread", { title: "Count", message: "count" }),
          fauxToolCall("start_thread", { title: "Read", message: "read" }),
        ],
        { stopReason: "toolUse" },
      );
    }

    if (last.includes("finished a turn") || last.includes("[Thread")) {
      wakes.push(last);

      return fauxAssistantMessage([
        fauxText(
          seen.includes("counted 3") && seen.includes("read 7")
            ? "summary: counted 3, read 7"
            : "waiting for the other thread",
        ),
      ]);
    }

    return fauxAssistantMessage([fauxText("started two threads")]);
  };

  faux.setResponses(Array.from({ length: 20 }, () => reply));

  await until(
    async () => (await (await api("/api/environments")).json()) as unknown[],
    (environments) => environments.length > 0,
  );

  const { coordinatorId } = (await (
    await api("/api/plugins/projects/projects", {
      name: "Split",
      repositories: [a],
    })
  ).json()) as ProjectView;

  await until(
    async () =>
      (await (await api(`/api/sessions/${coordinatorId}`)).json()) as Session,
    (session) => session.status === "idle",
  );

  await api(`/api/sessions/${coordinatorId}/commands`, {
    type: "message",
    text: "split the work",
  });

  await until(
    async () => transcript(coordinatorId),
    (text) => text.includes("summary: counted 3, read 7"),
  );

  await new Promise((resolve) => setTimeout(resolve, 1500));

  expect(wakes).toHaveLength(2);
  expect(wakes.filter((wake) => wake.includes("[Thread"))).toHaveLength(1);
}, 30_000);

test("tells the coordinator about a failed thread turn without waking it", async () => {
  const a = await repository("app");
  const wakes: string[] = [];

  const reply = (context: {
    messages: readonly { role: string; content: unknown }[];
  }): AssistantMessage => {
    const seen = JSON.stringify(context.messages);
    const last = lastUserText(context.messages);

    if (!seen.includes("You are the coordinator")) {
      return fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "bad request: no such model",
      });
    }

    if (last.includes("start it")) {
      return fauxAssistantMessage(
        [fauxToolCall("start_thread", { title: "Read", message: "read" })],
        { stopReason: "toolUse" },
      );
    }

    if (last.includes("[Project notice]")) {
      wakes.push(last);
    }

    return fauxAssistantMessage([fauxText("ok")]);
  };

  faux.setResponses(Array.from({ length: 20 }, () => reply));

  await until(
    async () => (await (await api("/api/environments")).json()) as unknown[],
    (environments) => environments.length > 0,
  );

  const { coordinatorId } = (await (
    await api("/api/plugins/projects/projects", {
      name: "Failing",
      repositories: [a],
    })
  ).json()) as ProjectView;

  await until(
    async () =>
      (await (await api(`/api/sessions/${coordinatorId}`)).json()) as Session,
    (session) => session.status === "idle",
  );

  await api(`/api/sessions/${coordinatorId}/commands`, {
    type: "message",
    text: "start it",
  });

  await until(
    async () => transcript(coordinatorId),
    (text) =>
      text.includes(
        "ended its turn with a model error: bad request: no such model",
      ),
  );

  await new Promise((resolve) => setTimeout(resolve, 1500));

  expect(wakes).toHaveLength(0);
}, 30_000);

test("refuses a Project without repositories", async () => {
  const response = await api("/api/plugins/projects/projects", {
    name: "Empty",
    repositories: [],
  });

  expect(response.status).toBe(400);
});

test("shares files between the user and Project sessions through the library", async () => {
  const a = await repository("app");

  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("fetch_file", {
          name: "brief.txt",
          path: "app/brief.txt",
        }),
        fauxToolCall("publish_file", {
          path: "app/README.md",
          name: "readme.md",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("shared")]),
  ]);

  await until(
    async () => (await (await api("/api/environments")).json()) as unknown[],
    (environments) => environments.length > 0,
  );

  const { id, coordinatorId } = (await (
    await api("/api/plugins/projects/projects", {
      name: "Docs",
      repositories: [a],
    })
  ).json()) as ProjectView;

  const files = `/api/plugins/library/projects/${id}/files`;

  const uploaded = await fetch(new URL(`${files}/brief.txt`, server?.url), {
    method: "PUT",
    body: "the brief\n",
  });

  expect(uploaded.status).toBe(200);

  await until(
    async () =>
      (await (await api(`/api/sessions/${coordinatorId}`)).json()) as Session,
    (session) => session.status === "idle",
  );

  await api(`/api/sessions/${coordinatorId}/commands`, {
    type: "message",
    text: "share the readme",
  });

  await until(
    async () => transcript(coordinatorId),
    (text) => text.includes("shared"),
  );

  expect(
    await readFile(
      join(root, "local", "workspaces", coordinatorId, "app", "brief.txt"),
      "utf8",
    ),
  ).toBe("the brief\n");

  expect(await (await api(files)).json()).toMatchObject([
    { name: "brief.txt", size: 10, actor: "user:local" },
    { name: "readme.md", size: 4, actor: `session:${coordinatorId}` },
  ]);

  expect(await (await api(`${files}/readme.md`)).text()).toBe("app\n");
}, 30_000);
