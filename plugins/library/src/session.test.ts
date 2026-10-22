import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { SessionCloud } from "@pi-cloud/plugins";
import { fileLimit } from "./model";
import { library } from "./session";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-cloud-library-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function publisher(
  requests: string[],
): Promise<(path: string) => Promise<unknown>> {
  const unused = (): never => {
    throw new Error("not used by the library tools");
  };

  const cloud: SessionCloud = {
    publish: unused,
    askQuestions: unused,
    checkouts: [],
    request: async (path, init) => {
      requests.push(`${init?.method ?? "GET"} ${path}`);

      return Promise.resolve(
        init?.body instanceof Uint8Array && init.body.length > fileLimit
          ? Response.json(
              { error: "library files are limited to 10 MB" },
              { status: 413 },
            )
          : Response.json({}),
      );
    },
    log: () => undefined,
  };

  const tools = (await library.tools?.(cloud)) ?? [];
  const publish = tools.find(({ name }) => name === "publish_file");
  if (publish === undefined) {
    throw new Error("library offered no publish_file tool");
  }

  const context = { cwd } as ExtensionToolContext;

  return async (path) =>
    publish.execute("call-1", { path }, undefined, undefined, context);
}

test("refuses to publish a file over the size limit without sending it", async () => {
  await writeFile(join(cwd, "limit.bin"), new Uint8Array(fileLimit));
  await writeFile(join(cwd, "over.bin"), new Uint8Array(fileLimit + 1));
  const requests: string[] = [];
  const publish = await publisher(requests);

  await publish("limit.bin");

  expect(publish("over.bin")).rejects.toThrow(
    "library files are limited to 10 MB",
  );

  expect(requests).toEqual(["GET member", "PUT files/limit.bin"]);
});

test("publishes a file under its everyday name", async () => {
  const screenshot = "Screenshot 2026-10-22 at 10.15.32\u202fAM.png";
  await writeFile(join(cwd, screenshot), "png");
  await writeFile(join(cwd, "invoice (1).pdf"), "pdf");
  const requests: string[] = [];
  const publish = await publisher(requests);

  await publish(screenshot);
  await publish("invoice (1).pdf");

  expect(requests).toEqual([
    "GET member",
    `PUT files/${encodeURIComponent(screenshot)}`,
    "PUT files/invoice%20(1).pdf",
  ]);
});
