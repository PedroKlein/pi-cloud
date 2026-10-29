import { expect, test } from "bun:test";
import type { PluginRoute, RouteCaller } from "@pipoca/plugins";
import {
  fakeContext,
  fakeSession,
  fakeUser,
  served,
} from "@pipoca/plugins/testing";
import type { PluginSettings } from "@pipoca/protocol";
import { library } from "./server";

const session = fakeSession();

const member: RouteCaller = {
  kind: "session",
  session,
  actor: "session:session-1",
};

function registered(
  settings: () => PluginSettings = () => ({ fileLimitMb: 10 }),
): PluginRoute {
  const routes: PluginRoute[] = [];

  const context = fakeContext({
    routes: {
      handle: (route) => {
        routes.push(route);
      },
    },
    settings: { get: settings },
  });

  library.register(context);

  context.events.publish({
    type: "projects.MemberAdded",
    sessionId: session.id,
    projectId: "p1",
  });

  const [route] = routes;
  if (route === undefined) {
    throw new Error("library registered no route");
  }

  return served(route);
}

async function put(
  route: PluginRoute,
  path: string,
  body: string,
  caller: RouteCaller = fakeUser(),
): Promise<void> {
  const request = new Request(`http://library/${path}`, {
    method: "PUT",
    body,
  });

  expect((await route(request, path, caller)).status).toBe(200);
}

async function get(route: PluginRoute, path: string): Promise<Response> {
  return route(new Request(`http://library/${path}`), path, fakeUser());
}

test("lists each file of a Project by name with its latest size and writer", async () => {
  const route = registered();

  await put(route, "projects/p1/files/b.txt", "first draft");
  await put(route, "projects/p1/files/a.txt", "a");
  await put(route, "files/b.txt", "final", member);
  await put(route, "projects/p2/files/c.txt", "elsewhere");

  expect(await (await get(route, "projects/p1/files")).json()).toEqual([
    {
      name: "a.txt",
      size: 1,
      actor: "user:owner",
      updatedAt: expect.any(String) as unknown,
    },
    {
      name: "b.txt",
      size: 5,
      actor: "session:session-1",
      updatedAt: expect.any(String) as unknown,
    },
  ]);

  expect(await (await get(route, "projects/p1/files/b.txt")).text()).toBe(
    "final",
  );
});

test("accepts everyday file names and refuses only unsafe ones", async () => {
  const route = registered();

  const write = async (name: string): Promise<Response> => {
    const path = `projects/p1/files/${encodeURIComponent(name)}`;

    return route(
      new Request(`http://library/${path}`, { method: "PUT", body: "x" }),
      path,
      fakeUser(),
    );
  };

  const everyday = [
    "John's notes.txt",
    "Q&A, draft+v2 [final].md",
    "Screenshot 2026-10-22 at 10.15.32\u202fAM.png",
    "invoice (1).pdf",
    "٢٠٢٦.pdf",
    "第２回.pdf",
  ];

  const unsafe = [
    "a\\b.txt",
    "a/b.txt",
    "a\tb.txt",
    "a\nb.txt",
    "..",
    " a.txt",
    "a.txt ",
    "photo\u202egnp.exe",
    "x".repeat(201),
  ];

  const accepted = await Promise.all(everyday.map(write));
  const refused = await Promise.all(unsafe.map(write));

  expect(accepted.map(({ status }) => status)).toEqual(everyday.map(() => 200));
  expect(refused.map(({ status }) => status)).toEqual(unsafe.map(() => 400));

  expect(await refused[0]?.json()).toEqual({
    error: "bad_request",
    message:
      "file names can't be empty, longer than 200 characters or only dots, can't start or end with whitespace, and can't contain /, \\, control characters or text direction controls",
  });

  expect(await (await get(route, "projects/p1/files")).json()).toMatchObject(
    everyday.map((name) => ({ name })),
  );

  const download = await get(
    route,
    `projects/p1/files/${encodeURIComponent("invoice (1).pdf")}`,
  );

  expect(download.headers.get("content-disposition")).toBe(
    "attachment; filename*=UTF-8''invoice%20%281%29.pdf",
  );
});

test("treats the composed and decomposed spellings of a name as one file", async () => {
  const route = registered();
  const composed = encodeURIComponent("r\u00e9sum\u00e9.pdf");
  const decomposed = encodeURIComponent("re\u0301sume\u0301.pdf");

  await put(route, `projects/p1/files/${decomposed}`, "from mac");

  const fetched = await route(
    new Request(`http://library/files/${composed}`),
    `files/${composed}`,
    member,
  );

  expect(fetched.status).toBe(200);
  expect(await fetched.text()).toBe("from mac");

  await put(route, `files/${composed}`, "from linux", member);

  expect(await (await get(route, "projects/p1/files")).json()).toMatchObject([
    { name: "r\u00e9sum\u00e9.pdf", size: 10 },
  ]);

  expect(
    await (await get(route, `projects/p1/files/${decomposed}`)).text(),
  ).toBe("from linux");
});

test("refuses a file over the size limit in the settings as they are now", async () => {
  let settings: PluginSettings = { fileLimitMb: 1 };
  const route = registered(() => settings);
  const path = "projects/p1/files/big.bin";

  const putBig = async (): Promise<Response> =>
    route(
      new Request(`http://library/${path}`, {
        method: "PUT",
        body: new Uint8Array(1024 * 1024 + 1),
      }),
      path,
      fakeUser(),
    );

  const refused = await putBig();

  expect(refused.status).toBe(413);

  expect(await refused.json()).toEqual({
    error: "too_large",
    message: "library files are limited to 1 MB",
  });

  settings = { fileLimitMb: 2 };

  expect((await putBig()).status).toBe(200);
});
