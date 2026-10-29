import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type Browser,
  chromium,
  type Locator,
  type Page,
  type Route,
} from "playwright-core";
import type { Environment } from "@pipoca/protocol";
import { installedPlugins } from "./installed";
import { serve } from "./serve";
import { setupTokenOf } from "./testdata/sign-in";

let root: string;
let server: ReturnType<typeof serve>;
let browser: Browser;
let page: Page;
let cookie: string;

const faux = fauxProvider({
  models: [{ id: "faux-1" }, { id: "faux-deep", reasoning: true }],
});

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-e2e-")));

  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);

  const plugins = join(root, "plugins");
  await mkdir(join(plugins, "hello"), { recursive: true });

  await writeFile(
    join(plugins, "hello", "package.json"),
    JSON.stringify({
      pipoca: {
        id: "hello",
        title: "Hello",
        description: "Says hi.",
        engine: 1,
      },
    }),
  );

  await mkdir(join(plugins, "greeter"));

  await writeFile(
    join(plugins, "greeter", "package.json"),
    JSON.stringify({
      pipoca: {
        id: "greeter",
        title: "Greeter",
        description: "Counts hellos.",
        engine: 1,
        parts: { web: "web.tsx" },
      },
    }),
  );

  // Hooks only work when the part shares the page's React.
  await writeFile(
    join(plugins, "greeter", "web.tsx"),
    `import { Button } from "@pipoca/ui";
import { useState } from "react";

function Page() {
  const [count, setCount] = useState(0);

  return <Button onClick={() => setCount(count + 1)}>Hellos: {count}</Button>;
}

export default { name: "greeter", nav: { label: "Greeter", Page } };
`,
  );

  await mkdir(join(plugins, "faulty"));

  await writeFile(
    join(plugins, "faulty", "package.json"),
    JSON.stringify({
      pipoca: {
        id: "faulty",
        title: "Faulty",
        description: "Throws when it loads.",
        engine: 1,
        parts: { web: "web.ts" },
      },
    }),
  );

  await writeFile(
    join(plugins, "faulty", "web.ts"),
    `throw new Error("faulty on purpose");
`,
  );

  await writeFile(
    join(plugins, "enabled.json"),
    JSON.stringify(["faulty", "greeter"]),
  );

  const logs: string[] = [];

  server = serve({
    port: 0,
    database: ":memory:",
    sessions: { pollWaitMs: 100, offlineAfterMs: 1000 },
    agent: {
      provider: "e2e",
      dataDir: join(root, "e2e"),
      extensionPaths: [],
      folders: [root],
      models: { runtime, model: faux.getModel() },
    },
    installed: {
      root: plugins,
      plugins: await installedPlugins(plugins, () => undefined),
    },
    log: (message, fields) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
    },
  });

  browser = await chromium.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(10_000);

  await page.goto(new URL(`/#setup/${setupTokenOf(logs)}`, server.url).href);
  await page.getByRole("heading", { name: "Create the first user" }).waitFor();
  await page.getByLabel("Name").fill("pedro");
  await page.getByLabel("Password").fill("correct horse");
  await page.getByRole("button", { name: "Create user" }).click();
  await page.getByRole("button", { name: "New session" }).waitFor();

  const [session] = await page.context().cookies();
  cookie = `${session?.name ?? ""}=${session?.value ?? ""}`;
});

// Picks the e2e Environment and the folder in the New session composer.
// A folder is shared unless share is false, which makes a worktree of it.
async function pickWorkspace(
  form: Locator,
  where: string,
  share = true,
): Promise<void> {
  const environment = form.getByRole("button", { name: "Environment" });

  if ((await environment.count()) > 0) {
    await environment.click();
    await form.getByRole("option", { name: /^e2e/ }).click();
  }

  await form.getByRole("button", { name: "Folder or repository" }).click();
  const search = form.getByRole("combobox", { name: "Folder or repository" });
  const picked = form.getByRole("option", { selected: true });

  // The composer remembers the last pick.
  while ((await picked.count()) > 0) {
    await picked.first().click();
  }

  await search.fill(where);

  await form
    .getByRole("option")
    .filter({ hasText: new RegExp(`${RegExp.escape(where)}(folder|clone)?$`) })
    .first()
    .click();

  await form.getByLabel(/^Share the folder/).setChecked(share);
  await search.press("Escape");
}

// Opens a section of the Settings page from the account menu.
async function openSettings(section: string): Promise<void> {
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();

  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("link", { name: section, exact: true })
    .click();
}

// A folder with its own .pi asks before loading it (ADR 0031).
async function trustRepository(): Promise<void> {
  await page
    .locator('[data-role="prompt"]')
    .getByRole("button", { name: "Trust it", exact: true })
    .click();
}

afterAll(async () => {
  await browser.close();
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

test("chats with a session, replays it after a reload and opens its terminal", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("hello from faux pi")])]);
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  await page.locator("#prompt-text").fill("hi");
  await page.locator("#prompt-text").press("Enter");

  const reply = page.locator('#chat li[data-role="assistant"]');
  await reply.filter({ hasText: "hello from faux pi" }).waitFor();

  await page.reload();
  await reply.filter({ hasText: "hello from faux pi" }).waitFor();

  expect(
    await page.locator('#chat li[data-role="user"]').allTextContents(),
  ).toEqual(["hi"]);

  await page.getByRole("button", { name: "Terminal" }).click();
  await page.locator("#terminal .xterm").click();
  await page.keyboard.type("echo e2e-$((6 * 7))\n");

  await page
    .locator("#terminal .xterm-rows")
    .filter({ hasText: "e2e-42" })
    .waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  const keys = page.getByRole("toolbar", { name: "Terminal keys" });
  await page.keyboard.type("echo one");
  await keys.getByRole("button", { name: "Ctrl" }).click();
  await page.keyboard.type("u");
  await page.keyboard.type("echo e2e-$((5 * 5))\n");
  const rows = page.locator("#terminal .xterm-rows");
  await rows.filter({ hasText: "e2e-25" }).waitFor();

  expect(await rows.textContent()).not.toContain("oneu");

  expect(
    await keys
      .getByRole("button", { name: "Ctrl" })
      .getAttribute("aria-pressed"),
  ).toBe("false");

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.keyboard.type("SURVIVE=yes\n");
  await page.getByRole("button", { name: "Chat" }).click();
  await page.getByRole("button", { name: "Terminal" }).click();
  await rows.filter({ hasText: "e2e-25" }).waitFor();
  await page.locator("#terminal .xterm").click();
  await page.keyboard.type("echo survived=$SURVIVE\n");
  await rows.filter({ hasText: "survived=yes" }).waitFor();

  const tabs = page.getByRole("tablist", { name: "Terminals" });
  await tabs.getByRole("tab", { name: "Terminal 1" }).waitFor();
  await tabs.getByRole("button", { name: "New terminal" }).click();
  await tabs.getByRole("tab", { name: "Terminal 2" }).waitFor();
  await tabs.getByRole("button", { name: "Close Terminal 2" }).click();

  await tabs
    .getByRole("tab", { name: "Terminal 2" })
    .waitFor({ state: "detached" });

  await rows.filter({ hasText: "survived=yes" }).waitFor();
}, 30_000);

test("chats from Pi's own TUI and goes back to the chat when Pi quits", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("hello from the tui")])]);
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  await page.getByRole("button", { name: "Pi", exact: true }).click();
  const rows = page.locator("#terminal .xterm-rows");
  await rows.filter({ hasText: "Pi can explain" }).waitFor();
  await page.locator("#terminal .xterm").click();
  await page.keyboard.type("hi from the web tui");
  await page.keyboard.press("Enter");
  await rows.filter({ hasText: "hello from the tui" }).waitFor();
  await page.keyboard.press("Control+d");

  await page
    .locator('#chat li[data-role="assistant"]', {
      hasText: "hello from the tui",
    })
    .waitFor();

  expect(
    await page.locator('#chat li[data-role="user"]').allTextContents(),
  ).toEqual(["hi from the web tui"]);
}, 30_000);

test("asks the assistant from the home screen and lists the conversation", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("Happy to help")])]);
  await page.goto(server.url.href);

  await page
    .getByRole("heading", { name: "What do you want to build today?" })
    .waitFor();

  const ask = page.getByLabel("Ask the Pipoca assistant");
  await ask.fill("What can you do?");
  await ask.press("Enter");

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "Happy to help" })
    .waitFor();

  expect(new URL(page.url()).hash).toMatch(/^#plugin\/meta\/[\w-]+$/);

  await page
    .locator('nav a[aria-current="page"]', { hasText: "What can you do?" })
    .waitFor({ timeout: 2000 });

  await page.goto(server.url.href);

  await page
    .getByRole("region", { name: "Earlier conversations" })
    .getByRole("link", { name: "What can you do?" })
    .waitFor();
}, 30_000);

test("asks the assistant with the model picked last time", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("Deep answer")])]);
  await page.goto(server.url.href);

  const ask = page.getByLabel("Ask the Pipoca assistant");

  const model = page
    .locator("form", { has: ask })
    .getByRole("button", { name: "Model" });

  await model.click();
  await page.getByRole("option", { name: "faux-deep" }).click();

  await ask.fill("Think hard");
  await ask.press("Enter");

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "Deep answer" })
    .waitFor();

  const sessions = (await (
    await fetch(new URL("/api/plugins/meta/sessions", server.url), {
      headers: { cookie },
    })
  ).json()) as { firstMessage: string; model: { id: string } | null }[];

  await page.goto(server.url.href);

  expect(
    sessions.find(({ firstMessage }) => firstMessage === "Think hard")?.model
      ?.id,
  ).toBe("faux-deep");

  await model.filter({ hasText: "faux-deep" }).waitFor();

  await model.click();
  await page.getByRole("option", { name: "Default model" }).click();
}, 30_000);

test("goes where the assistant opens on a wide screen, and offers it on a phone", async () => {
  const startOne = (): ReturnType<typeof fauxAssistantMessage> =>
    fauxAssistantMessage(
      [
        fauxToolCall("sessions_start", {
          workspace: { kind: "folder", path: root },
        }),
      ],
      { stopReason: "toolUse" },
    );

  faux.setResponses([
    startOne(),
    fauxAssistantMessage([fauxText("started one")]),
    startOne(),
    fauxAssistantMessage([fauxText("started another")]),
  ]);

  const ask = async (text: string): Promise<void> => {
    await page.goto(server.url.href);
    const composer = page.getByLabel("Ask the Pipoca assistant");
    await composer.fill(text);
    await composer.press("Enter");
    await page.getByRole("button", { name: "Yes" }).click();
  };

  await ask("Start a session in my folder");
  await page.waitForURL(/#(?!plugin\/)[\w-]+$/);

  await page.setViewportSize({ width: 390, height: 844 });
  await ask("Start another one");

  const notice = page.getByRole("status").filter({
    hasText: "Open the new Session?",
  });

  await notice.waitFor();

  expect(new URL(page.url()).hash).toMatch(/^#plugin\/meta\//);

  await notice.getByRole("link", { name: "Open" }).click();
  await page.waitForURL(/#(?!plugin\/)[\w-]+$/);
  await page.setViewportSize({ width: 1280, height: 720 });
}, 30_000);

test("infers the workspace from what the New session composer picks and remembers it", async () => {
  const asked: unknown[] = [];

  await page.route("**/api/sessions", async (route) => {
    asked.push(route.request().postDataJSON());

    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "not this time" }),
    });
  });

  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, "https://example.com/a.git");
  await form.getByRole("button", { name: "Start session" }).click();
  await form.getByRole("alert").filter({ hasText: "not this time" }).waitFor();

  await form.getByRole("button", { name: "Folder or repository" }).click();
  const search = form.getByRole("combobox", { name: "Folder or repository" });

  await search.fill("https://example.com/b.git");
  await search.press("Enter");
  await search.press("Escape");
  const second = page.waitForResponse("**/api/sessions");

  await form.getByRole("button", { name: "Start session" }).click();
  await second;

  await page.reload();
  await page.getByRole("button", { name: "New session" }).click();
  await form.getByRole("button", { name: "Folder or repository" }).waitFor();

  await page.unroute("**/api/sessions");

  expect(asked).toMatchObject([
    {
      workspace: {
        kind: "clone",
        repository: "https://example.com/a.git",
        startPoint: "",
      },
    },
    {
      workspace: {
        kind: "repositories",
        repositories: [
          { repository: "https://example.com/a.git" },
          { repository: "https://example.com/b.git" },
        ],
      },
    },
  ]);

  expect(
    await form
      .getByRole("button", { name: "Folder or repository" })
      .textContent(),
  ).toBe("a, b");
}, 30_000);

test("starts a session with the task from the New session form", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("on it")])]);
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);

  const task = form.getByLabel("What should Pi do?");

  await task.fill("Paginate the session list");
  await task.press("Control+Enter");

  await page
    .locator('#chat li[data-role="user"]', {
      hasText: "Paginate the session list",
    })
    .waitFor();

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "on it" })
    .waitFor();
}, 30_000);

test("walks a new server through connecting a machine and logging in to a model", async () => {
  let phase: "none" | "no models" = "none";
  const asked: unknown[] = [];

  await page.route("**/api/environments", async (route) => {
    const real = (await (await route.fetch()).json()) as Environment[];

    await route.fulfill({
      json:
        phase === "none"
          ? []
          : real.slice(0, 1).map((each) => ({ ...each, models: [] })),
    });
  });

  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();

      return;
    }

    asked.push(route.request().postDataJSON());
    await route.fulfill({ status: 400, json: { error: "not this time" } });
  });

  await page.goto(server.url.href);
  const steps = page.getByRole("region", { name: "Get started" });

  await steps.getByRole("button", { name: "Show the command" }).click();

  const command = steps.getByLabel("Join command");
  await command.filter({ hasText: "PIPOCA_KEY=pck_" }).waitFor();

  expect(await command.textContent()).toEndWith(
    `pipoca agent --server ${server.url.origin}`,
  );

  phase = "no models";
  await page.reload();

  await steps
    .getByRole("heading", { name: "Connect a machine (done)" })
    .waitFor();

  await steps.getByRole("button", { name: "Log in" }).click();
  await steps.getByRole("alert").filter({ hasText: "not this time" }).waitFor();

  expect(asked).toMatchObject([
    { workspace: { kind: "folder" }, firstMessage: "/login" },
  ]);

  await page.unroute("**/api/sessions");
  await page.unroute("**/api/environments");
  await page.reload();

  await page
    .getByRole("navigation", { name: "Pipoca" })
    .getByText(/^e2e\b.* online$/)
    .waitFor();

  expect(await steps.count()).toBe(0);
});

test("makes an Environment and shows its key once", async () => {
  await page.goto(server.url.href);
  await openSettings("Environments");

  await page.getByLabel("New Environment name").fill("builders");
  await page.getByRole("button", { name: "New Environment" }).click();

  const command = page.getByLabel("Join command");
  await command.filter({ hasText: "PIPOCA_KEY=pck_" }).waitFor();

  expect(await command.textContent()).toContain(
    `--server ${server.url.origin}`,
  );

  await page.reload();
  await page.getByRole("button", { name: "Replace key" }).waitFor();

  expect(await command.count()).toBe(0);

  await page.getByRole("link", { name: /^e2e/ }).click();

  await page
    .getByRole("list", { name: "Folders" })
    .getByText(root, { exact: true })
    .waitFor();
});

test("changes a plugin's setting on the Plugins page", async () => {
  await page.goto(server.url.href);
  await openSettings("Plugins");

  const library = page.getByRole("listitem", { name: "Library" });
  await library.getByText("On", { exact: true }).waitFor();

  const limit = library.getByLabel(/^File size limit in MB/);
  expect(await limit.inputValue()).toBe("10");

  await limit.fill("25");
  await library.getByRole("button", { name: "Save" }).click();
  await library.getByText("Saved").waitFor();

  await page.reload();
  expect(await limit.inputValue()).toBe("25");

  await limit.fill("10");
  await library.getByRole("button", { name: "Save" }).click();
  await library.getByText("Saved").waitFor();
});

test("turns an installed plugin on for the next start", async () => {
  await page.goto(server.url.href);
  await openSettings("Plugins");

  const hello = page.getByRole("listitem", { name: "Hello" });
  await hello.getByText("Installed", { exact: true }).waitFor();

  page.once("dialog", (dialog) => {
    void dialog.accept();
  });

  await hello.getByRole("switch", { name: "On" }).click();
  await hello.getByText("It turns on when the server restarts.").waitFor();
  await hello.getByText("Off until restart").waitFor();

  await page.getByRole("button", { name: "Restart now" }).click();
  await page.getByText(/restart it yourself/).waitFor();

  await page.reload();
  await hello.getByRole("switch", { name: "On", checked: true }).click();
  await hello.getByRole("switch", { name: "On", checked: false }).waitFor();

  expect(await hello.getByText(/when the server restarts/).count()).toBe(0);
});

test("installs a plugin from a git repository, asks before turning it on, and removes it", async () => {
  const source = join(root, "sources", "weather");
  await mkdir(source, { recursive: true });

  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      pipoca: {
        id: "weather",
        title: "Weather",
        description: "Says the weather.",
        engine: 1,
        capabilities: ["routes"],
      },
    }),
  );

  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c"],
  ]) {
    execFileSync("git", ["-C", source, ...args]);
  }

  await page.goto(server.url.href);
  await openSettings("Plugins");

  await page
    .getByLabel(/Install from a git repository/)
    .fill(`file://${source}`);

  await page.getByRole("button", { name: "Install" }).click();

  await page.getByText("Installed Weather, turned off.").waitFor();

  const weather = page.getByRole("listitem", { name: "Weather" });
  await weather.getByText(`file://${source} at`).waitFor();

  const asked = new Promise<string>((resolve) => {
    page.once("dialog", (dialog) => {
      resolve(dialog.message());
      void dialog.accept();
    });
  });

  await weather.getByRole("switch", { name: "On" }).click();
  expect(await asked).toContain("It asks for routes");
  await weather.getByRole("switch", { name: "On", checked: true }).click();

  page.once("dialog", (dialog) => {
    void dialog.accept();
  });

  await weather.getByRole("button", { name: "Remove" }).click();
  await weather.waitFor({ state: "detached" });
});

test("shows an installed plugin's page with the app's React and components", async () => {
  await page.goto(server.url.href);
  await openSettings("Plugins");

  expect(
    await page
      .getByRole("listitem", { name: "Greeter" })
      .getByRole("button", { name: "Remove" })
      .isDisabled(),
  ).toBe(true);

  // A newly installed plugin's page starts under More (ADR 0040).
  await page
    .locator("#plugin-nav")
    .getByRole("button", { name: "More" })
    .click();

  await page.getByRole("link", { name: "Greeter" }).click();

  const button = page.getByRole("button", { name: "Hellos: 0" });
  await button.click();
  await page.getByRole("button", { name: "Hellos: 1" }).waitFor();
});

test("says why an installed plugin's web part didn't load, and draws the rest", async () => {
  await page.goto(server.url.href);
  await openSettings("Plugins");

  await page
    .getByRole("listitem", { name: "Faulty" })
    .getByText("Its web part didn't load: faulty on purpose")
    .waitFor();
});

test("pins a plugin page to the sidebar and keeps the rest under More", async () => {
  await page.goto(server.url.href);
  const nav = page.locator("#plugin-nav");
  const library = nav.getByRole("link", { name: "Library" });

  await nav.getByRole("link", { name: "Projects" }).waitFor();
  expect(await library.count()).toBe(0);

  await nav.getByRole("button", { name: "More" }).click();
  await nav.getByRole("button", { name: "Pin Library" }).click();
  await nav.getByRole("button", { name: "Unpin Library" }).waitFor();

  await page.reload();
  await library.waitFor();
  expect(await nav.getByRole("button", { name: "More" }).count()).toBe(1);

  await nav.getByRole("button", { name: "Unpin Library" }).click();
  await page.reload();
  await nav.getByRole("link", { name: "Projects" }).waitFor();
  expect(await library.count()).toBe(0);
});

test("puts a pin back when the server doesn't save it", async () => {
  const { promise: pinned, resolve: refuse } = Promise.withResolvers();

  await page.route("**/api/pinned-pages", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();

      return;
    }

    await pinned;
    await route.fulfill({ status: 500, json: { error: "disk full" } });
  });

  await page.goto(server.url.href);
  const nav = page.locator("#plugin-nav");

  await nav.getByRole("button", { name: "More" }).click();
  await nav.getByRole("button", { name: "Pin Library" }).click();
  await nav.getByRole("button", { name: "Unpin Library" }).waitFor();
  refuse(undefined);

  await nav
    .getByRole("button", { name: "Pin Library", exact: true })
    .waitFor({ timeout: 2000 });

  await page.unroute("**/api/pinned-pages");
});

test("connects a model provider from Settings by answering its prompts", async () => {
  await page.goto(server.url.href);
  await openSettings("Logins");

  await page.getByRole("button", { name: "Connect a provider" }).click();

  const form = page.getByRole("form", { name: "Connect a model provider" });
  await form.getByLabel("Provider").selectOption({ label: "Mistral" });
  await form.getByLabel("Log in with").selectOption({ label: "API key" });
  await form.getByRole("button", { name: "Connect" }).click();

  const card = page.getByRole("region", { name: "Connecting Mistral" });
  await card.locator('input[type="password"]').fill("sk-mistral");
  await card.getByRole("button", { name: "Continue" }).click();

  await card.getByText("Connected to Mistral.").waitFor();

  await page
    .getByRole("list", { name: "Your model logins" })
    .getByText("mistral")
    .waitFor();

  await card.getByRole("button", { name: "Close" }).click();
  await card.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Log out of mistral" }).click();
});

test("signs in to an MCP server of the base Profile from Settings and comes back to Pipoca", async () => {
  // An MCP server whose authorization server signs anyone in at once.
  const linear: Bun.Server<undefined> = Bun.serve({
    port: 0,
    fetch: (request): Response => {
      const url = new URL(request.url);
      const origin = linear.url.origin;

      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
        });
      }

      if (url.pathname.startsWith("/.well-known/")) {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }

      if (url.pathname === "/authorize") {
        const back = new URL(url.searchParams.get("redirect_uri") ?? "");
        back.searchParams.set("code", "granted");
        back.searchParams.set("state", url.searchParams.get("state") ?? "");

        return Response.redirect(back.href, 302);
      }

      if (url.pathname === "/register") {
        return Response.json({ client_id: "client-1" }, { status: 201 });
      }

      if (url.pathname === "/token") {
        return Response.json({
          access_token: "access-1",
          refresh_token: "refresh-1",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }

      return new Response("unauthorized", { status: 401 });
    },
  });

  const base = async (mcpServers: unknown): Promise<void> => {
    await fetch(new URL("/api/base", server.url), {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ mcpServers }),
    });
  };

  try {
    await base({ linear: { url: `${linear.url.origin}/mcp` } });

    await page.goto(server.url.href);
    await openSettings("Logins");
    await page.getByRole("button", { name: "Sign in to linear" }).click();

    const card = page.getByRole("region", { name: "Connecting linear" });
    const opened = page.context().waitForEvent("page");
    await card.getByRole("link", { name: "Open the sign-in page" }).click();

    const tab = await opened;
    await tab.getByText("Signed in. You can close this tab.").waitFor();
    await tab.close();

    await card.getByText("Connected to linear.").waitFor();
    await page.getByRole("button", { name: "Log out of linear" }).waitFor();
  } finally {
    await base({});
    await linear.stop(true);
  }
});

test("makes an MCP token that works once shown, and revokes it", async () => {
  await page.goto(server.url.href);
  await openSettings("MCP clients");

  await page.getByLabel("Client name").fill("My laptop");
  await page.getByRole("button", { name: "New token" }).click();

  const command = await page.getByLabel("Add command").textContent();
  const secret = /Bearer (pcm_[\w-]+)/.exec(command ?? "")?.[1] ?? "";

  const ping = async (): Promise<number> =>
    (
      await fetch(new URL("/api/mcp", server.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      })
    ).status;

  expect(command).toContain(`${server.url.origin}/api/mcp`);
  expect(await ping()).toBe(200);

  await page.reload();
  await page.getByLabel("Add command").waitFor({ state: "detached" });
  expect(await page.content()).not.toContain(secret);

  page.once("dialog", async (dialog) => dialog.accept());

  await page.getByRole("button", { name: "Revoke My laptop" }).click();
  await page.getByText("No client has a token.").waitFor();
  expect(await ping()).toBe(401);
});

test("says why an MCP token wasn't revoked", async () => {
  await page.goto(server.url.href);
  await openSettings("MCP clients");

  await page.getByLabel("Client name").fill("Old laptop");
  await page.getByRole("button", { name: "New token" }).click();
  const revoke = page.getByRole("button", { name: "Revoke Old laptop" });

  await page.route("**/api/mcp-tokens/*", async (route) =>
    route.fulfill({ status: 500, json: { error: "token store is locked" } }),
  );

  page.once("dialog", async (dialog) => dialog.accept());
  await revoke.click();
  await page.getByRole("alert").getByText("token store is locked").waitFor();
  await page.unroute("**/api/mcp-tokens/*");

  page.once("dialog", async (dialog) => dialog.accept());
  await revoke.click();
  await page.getByText("No client has a token.").waitFor();
  expect(await page.getByRole("alert").count()).toBe(0);
});

test("edits an Environment's variables and secrets without showing secret values", async () => {
  await page.goto(server.url.href);
  await openSettings("Environments");

  const editor = page.locator("#environments-page form");

  await editor.getByRole("button", { name: "Add", exact: true }).click();

  // Pasting a .env into a name fills the rows.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: server.url.origin,
  });

  await page.evaluate(
    "navigator.clipboard.writeText('export MODE=test\\n# a comment\\nTOKEN=\"s3cret\"\\n')",
  );

  await editor.getByLabel("Name of row 1").press("ControlOrMeta+V");

  await editor.getByRole("button", { name: "Keep TOKEN secret" }).click();
  await editor.getByRole("button", { name: "Save" }).click();

  await editor
    .getByPlaceholder("Saved, type to replace")
    .and(editor.getByLabel("Value of TOKEN"))
    .waitFor();

  await page.reload();

  expect(await editor.getByLabel("Value of MODE").inputValue()).toBe("test");
  expect(await editor.getByLabel("Value of TOKEN").inputValue()).toBe("");
  expect(await page.content()).not.toContain("s3cret");

  await editor.getByRole("button", { name: "Remove TOKEN" }).click();

  // A change made elsewhere while the page is open survives a save here.
  const [environment] = (await (
    await fetch(new URL("/api/environments", server.url), {
      headers: { cookie },
    })
  ).json()) as { readonly id: string; readonly name: string }[];

  await fetch(
    new URL(`/api/environments/${environment?.id ?? ""}`, server.url),
    {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ image: "elsewhere:1" }),
    },
  );

  await editor.getByLabel("Name", { exact: true }).fill("Laptops");
  await editor.getByRole("button", { name: "Save" }).click();

  const environments = async (): Promise<
    readonly { readonly name: string }[]
  > =>
    (await (
      await fetch(new URL("/api/environments", server.url), {
        headers: { cookie },
      })
    ).json()) as {
      readonly name: string;
    }[];

  let saved = await environments();
  while (saved[0]?.name !== "Laptops") {
    await Bun.sleep(50);
    saved = await environments();
  }

  expect(saved[0]).toMatchObject({
    name: "Laptops",
    image: "elsewhere:1",
    variables: { MODE: "test" },
    secrets: [],
  });

  await fetch(
    new URL(`/api/environments/${environment?.id ?? ""}`, server.url),
    {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: environment?.name,
        image: null,
        variables: {},
      }),
    },
  );
}, 30_000);

test("starts and stops runner pods from an Environment's Kubernetes section", async () => {
  await page.goto(server.url.href);
  await openSettings("Environments");

  const section = page.getByLabel("Kubernetes", { exact: true });
  await section.getByText("isn't running in a cluster").waitFor();

  await section.getByLabel("Workspace").selectOption("claim");
  await section.getByLabel("Claim size").fill("2Gi");
  await section.getByLabel("Most pods").fill("3");
  await section.getByRole("button", { name: "Start runner pods" }).click();
  await section.getByRole("button", { name: "Stop runner pods" }).waitFor();

  const [environment] = (await (
    await fetch(new URL("/api/environments", server.url), {
      headers: { cookie },
    })
  ).json()) as { readonly id: string }[];

  const settings = async (): Promise<unknown> =>
    (
      (await (
        await fetch(
          new URL(
            `/api/plugins/kubernetes/environments/${environment?.id ?? ""}`,
            server.url,
          ),
          { headers: { cookie } },
        )
      ).json()) as { readonly settings: unknown }
    ).settings;

  expect(await settings()).toMatchObject({
    workspace: "claim",
    claimSize: "2Gi",
    maxPods: 3,
    storageClass: null,
  });

  await page.reload();

  expect(await section.getByLabel("Claim size").inputValue()).toBe("2Gi");

  await section.getByLabel(/^Pod patch/).fill("{");
  await section.getByRole("button", { name: "Save" }).click();
  await section.getByRole("alert").getByText("isn't valid JSON").waitFor();

  await section.getByLabel(/^Pod patch/).fill("{}");
  await section.getByRole("button", { name: "Save" }).click();
  await section.getByRole("alert").waitFor({ state: "detached" });

  await section.getByRole("button", { name: "Stop runner pods" }).click();
  await section.getByRole("button", { name: "Start runner pods" }).waitFor();

  expect(await settings()).toBeNull();
});

test("shows why an Environment's last runner pod failed", async () => {
  await page.route("**/api/plugins/kubernetes/environments/*", async (route) =>
    route.fulfill({
      json: {
        settings: null,
        startsPods: true,
        lastFailure: {
          pod: "pi-runner-1a2b3c4d",
          problem: "runner exited with 1: EACCES: permission denied",
          at: "2026-10-25T11:00:00.000Z",
          retryAt: "2026-10-25T11:00:20.000Z",
        },
      },
    }),
  );

  await page.goto(server.url.href);
  await openSettings("Environments");

  const failure = page
    .getByLabel("Kubernetes", { exact: true })
    .getByRole("alert");

  await failure.getByText("EACCES: permission denied").waitFor();

  expect(await failure.textContent()).toContain(
    "Runner pod pi-runner-1a2b3c4d failed",
  );

  await page.unroute("**/api/plugins/kubernetes/environments/*");
});

test("lists a Profile's packages as chips and edits its folder's files", async () => {
  await page.goto(server.url.href);
  await openSettings("Profiles");
  await page.getByRole("link", { name: "New Profile" }).click();

  const editor = page.locator("#profiles-page form").first();
  const add = editor.getByLabel("Add to Pi packages");

  await editor.getByLabel("Name").fill("Tools");
  await add.fill("npm:pi-subagents");
  await add.press("Enter");
  await add.fill("./tools");
  await add.press("Enter");
  await editor.getByRole("button", { name: "Remove npm:pi-subagents" }).click();
  await editor.getByRole("button", { name: "Create Profile" }).click();
  await page.getByRole("link", { name: "Tools" }).waitFor();
  await page.reload();

  const packages = editor.getByRole("list", { name: "Pi packages" });

  await packages.getByText("./tools").waitFor();
  expect(await packages.getByRole("listitem").count()).toBe(1);

  const profilesPage = page.locator("#profiles-page");
  const tabs = profilesPage.getByRole("navigation", { name: "Profile" });

  await tabs.getByRole("link", { name: "Files" }).click();
  await profilesPage.getByRole("button", { name: "settings.json" }).waitFor();

  await profilesPage
    .getByPlaceholder("skills/review/SKILL.md")
    .fill("prompts/fix.md");

  await profilesPage.getByRole("button", { name: "New", exact: true }).click();
  await profilesPage.getByLabel("prompts/fix.md").fill("Fix $1.");
  await profilesPage.getByRole("button", { name: "Save file" }).click();
  await profilesPage.getByRole("button", { name: "prompts/fix.md" }).waitFor();

  await tabs.getByRole("link", { name: "Prompts" }).click();
  await profilesPage.getByRole("button", { name: /^fix/ }).waitFor();

  await tabs.getByRole("link", { name: "Skills" }).click();
  await profilesPage.getByLabel("New in Skills").fill("review");
  await profilesPage.getByRole("button", { name: "New", exact: true }).click();

  expect(
    await profilesPage.getByLabel("skills/review/SKILL.md").inputValue(),
  ).toContain("name: review");

  await profilesPage.getByRole("button", { name: "Save file" }).click();
  await profilesPage.getByRole("button", { name: /^review/ }).waitFor();

  await tabs.getByRole("link", { name: "Overview" }).click();
  page.once("dialog", async (dialog) => dialog.accept());
  await editor.getByRole("button", { name: "Delete" }).click();

  await page
    .getByRole("link", { name: "Tools" })
    .waitFor({ state: "detached" });
});

test("imports a Profile from a picked folder with its files", async () => {
  const folder = join(root, "agent-folder");

  await mkdir(join(folder, "skills", "lint"), { recursive: true });
  await writeFile(join(folder, "skills", "lint", "SKILL.md"), "# Lint");
  await writeFile(join(folder, "auth.json"), "{}");

  await page.goto(server.url.href);
  await openSettings("Profiles");

  await page
    .locator("#profiles-page")
    .getByLabel("Choose a folder")
    .setInputFiles(folder);

  await page.getByRole("link", { name: "agent-folder" }).waitFor();
  await page.getByRole("link", { name: "Skills" }).click();

  await page
    .locator("#profiles-page")
    .getByRole("button", { name: /^lint/ })
    .waitFor();
});

test("makes a Profile and starts a session that follows its instructions", async () => {
  let request = "";

  faux.setResponses([
    (context) => {
      request = JSON.stringify(context);

      return fauxAssistantMessage([fauxText("arr")]);
    },
  ]);

  await page.goto(server.url.href);
  await openSettings("Profiles");
  await page.getByRole("link", { name: "New Profile" }).click();

  const editor = page.locator("#profiles-page form");

  await editor.getByLabel("Name").fill("Pirate");
  await editor.getByRole("button", { name: "Create Profile" }).click();
  await page.getByRole("link", { name: "Pirate" }).waitFor();
  await page.getByRole("link", { name: "Instructions" }).click();

  const instructions = page.locator("#profiles-page");

  await instructions.getByLabel("AGENTS.md").fill("Answer like a pirate.");
  await instructions.getByRole("button", { name: "Save" }).first().click();

  await instructions
    .getByRole("button", { name: "Save" })
    .first()
    .and(page.locator(":disabled"))
    .waitFor();

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Profile" }).click();
  await form.getByRole("option", { name: "Pirate" }).click();

  const task = form.getByLabel("What should Pi do?");

  await task.fill("Say hello");
  await task.press("Control+Enter");

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "arr" })
    .waitFor();

  expect(request).toContain("Answer like a pirate.");
}, 30_000);

test("archives a session, shows it only with archived sessions and unarchives it", async () => {
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();
  const id = new URL(page.url()).hash.slice(1);
  const item = page.locator(`#sessions li[data-id="${id}"]`);
  await item.waitFor();

  await page.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page.locator("#status", { hasText: "archived" }).waitFor();
  await page.locator("#prompt").waitFor({ state: "hidden" });
  await page.reload();
  await page.locator("#status", { hasText: "archived" }).waitFor();

  await item.waitFor({ state: "detached" });
  await page.getByLabel("Show archived").check();
  await item.waitFor();
  await page.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: "Unarchive" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  expect(new URL(page.url()).hash.slice(1)).toBe(id);
  expect(await page.locator("#prompt").isVisible()).toBe(true);
}, 30_000);

test("forks a session into a new one and opens it", async () => {
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();
  const id = new URL(page.url()).hash.slice(1);

  await page.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: "Fork" }).click();
  await page.waitForURL((url) => url.hash !== "" && url.hash !== `#${id}`);
  const fork = new URL(page.url()).hash.slice(1);

  await page.locator(`#sessions li[data-id="${fork}"]`).waitFor();
  await page.locator("#status", { hasText: "idle" }).waitFor();
}, 30_000);

test("finds sessions by search and notifies when one finishes", async () => {
  await page.context().grantPermissions(["notifications"]);

  await page.addInitScript(() => {
    const shown: string[] = [];

    Object.assign(globalThis, {
      shown,
      Notification: Object.assign(
        class {
          constructor(title: string) {
            shown.push(title);
          }

          addEventListener(): void {
            return undefined;
          }
        },
        { permission: "granted" },
      ),
    });
  });

  // Long enough for the two-second session poll to see it working.
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 3" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("done here")]),
  ]);

  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();
  const id = new URL(page.url()).hash.slice(1);
  const item = page.locator(`#sessions li[data-id="${id}"]`);

  await page.getByRole("button", { name: "Search" }).click();
  const search = page.getByLabel("Search sessions");
  await search.fill("no-such-session");
  await item.waitFor({ state: "detached" });
  await page.getByText("No sessions match.").waitFor();
  await search.fill("pipoca-e2e");
  await item.waitFor();

  await page.locator("#prompt-text").fill("finish");
  await page.locator("#prompt-text").press("Enter");

  await page
    .locator("#plugin-nav")
    .getByRole("link", { name: "Projects" })
    .click();

  await page.waitForFunction(() =>
    (globalThis as unknown as { shown: string[] }).shown.some((title) =>
      title.startsWith("Pi finished in"),
    ),
  );
}, 30_000);

test("answers the agent's questions in the prompt card", async () => {
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxText("Two quick questions."),
        fauxToolCall("ask_user", {
          questions: [
            {
              id: "size",
              label: "Size",
              prompt: "Which size?",
              type: "single",
              options: [
                { value: "s", label: "Small", description: "Cheap" },
                { value: "l", label: "Large", description: "Fast" },
              ],
            },
          ],
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("going large")]),
  ]);

  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  await page.locator("#prompt-text").fill("pick a size");
  await page.locator("#prompt-text").press("Enter");

  const card = page.locator('[data-role="prompt"]');
  await card.getByRole("heading", { level: 2, name: "Which size?" }).waitFor();
  await page.locator("#sessions").getByText("Needs you").waitFor();
  await card.getByLabel("Large").check();

  expect(
    await page.locator("#chat").getByText("Two quick questions.").count(),
  ).toBe(1);

  await card.getByText("Fast").waitFor();
  await card.getByRole("button", { name: "Review answers" }).click();
  await card.locator("dd", { hasText: "Large" }).waitFor();
  await card.getByRole("button", { name: "Submit" }).click();

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "going large" })
    .waitFor();

  await card.waitFor({ state: "detached" });

  await page
    .locator("#sessions")
    .getByText("Needs you")
    .waitFor({ state: "detached" });

  const work = page.locator('#chat li[data-role="work"]');

  await work
    .locator("summary", { hasText: /Worked for \d+s\s*· 1 other step/ })
    .waitFor();

  await page
    .locator('#chat [data-role="answer-meta"]', { hasText: "faux-1" })
    .getByText("just now")
    .waitFor();

  await work.locator("summary").first().click();
  await work.getByText("Asked").click();
  await work.locator("pre", { hasText: "Large" }).waitFor();
}, 30_000);

test("shows the session's changes and usage from their plugins", async () => {
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  await writeFile(join(root, ".git/info/exclude"), "/*\n!/notes.txt\n");

  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("write", { path: "notes.txt", content: "new notes\n" }),
    ]),
    fauxAssistantMessage([fauxText("wrote it")]),
  ]);

  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  await page.locator("#prompt-text").fill("write notes");
  await page.locator("#prompt-text").press("Enter");

  await page.getByRole("button", { name: "Diff, 1 file changed" }).click();
  const changes = page.getByRole("dialog", { name: "Changes" });
  await changes.getByText("Changes (1 file)").waitFor();
  await changes.locator("tr", { hasText: "new notes" }).waitFor();
  await page.keyboard.press("Escape");
  await changes.waitFor({ state: "hidden" });

  await page
    .locator('#plugin-header [data-plugin="usage"] [title*=" out "]')
    .waitFor();
}, 30_000);

test("shows a turn as working between steps until Pi finishes it", async () => {
  const { promise: answered, resolve: answer } =
    Promise.withResolvers<undefined>();

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "true" })], {
      stopReason: "toolUse",
    }),
    async () => {
      await answered;

      return fauxAssistantMessage([fauxText("all done")]);
    },
  ]);

  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  await page.locator("#prompt-text").fill("check");
  await page.locator("#prompt-text").press("Enter");

  const work = page.locator('#chat li[data-role="work"]');
  await work.getByText("ran 1 command").waitFor();
  await Bun.sleep(300);

  expect(await work.locator("summary").first().textContent()).toContain(
    "Working",
  );

  answer(undefined);
  await work.getByText(/^Worked for/).waitFor();
}, 30_000);

test("creates a Project and shares a file through its library", async () => {
  const repository = join(root, "site");
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", repository]);
  await writeFile(join(repository, "README.md"), "site\n");
  execFileSync("git", ["add", "."], { cwd: repository });

  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first"],
    { cwd: repository },
  );

  await page.goto(server.url.href);

  await page
    .locator("#plugin-nav")
    .getByRole("link", { name: "Projects" })
    .click();

  const form = page.locator("form.project-create");
  await form.getByLabel("Name").fill("Site");
  await form.getByLabel("Goal").fill("Publish the docs site.");
  await form.getByRole("button", { name: "Repositories" }).click();
  const search = form.getByRole("combobox", { name: "Repositories" });
  await search.fill(repository);
  await form.getByRole("option", { name: `Use ${repository}` }).click();
  await search.press("Escape");
  await form.getByRole("button", { name: "Create Project" }).click();
  await page.getByRole("heading", { level: 1, name: "Site" }).waitFor();
  const rail = page.getByRole("navigation", { name: "Threads" });
  await rail.getByText("No threads yet.").waitFor();

  await page.getByRole("button", { name: "Project settings" }).click();

  const settings = page.getByRole("complementary", {
    name: "Project settings",
  });

  expect(await settings.getByLabel("Goal").inputValue()).toBe(
    "Publish the docs site.",
  );

  await settings.getByLabel("Name").fill("Site docs");
  await settings.getByLabel("Thread model").fill("faux/faux-1");
  await settings.getByRole("button", { name: "Save settings" }).click();

  await page
    .getByRole("heading", { level: 1, name: "Site docs" })
    .waitFor({ timeout: 1000 });

  expect(await settings.getByLabel("Thread model").inputValue()).toBe(
    "faux/faux-1",
  );

  await settings.getByRole("button", { name: "Close settings" }).click();

  await page
    .locator("#project-nav")
    .getByRole("link", { name: /^Site/ })
    .filter({ hasText: "1 repository · coordinator" })
    .waitFor();

  const calls = faux.state.callCount;

  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("start_thread", { title: "Docs", message: "write docs" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("ok")]),
    fauxAssistantMessage([fauxText("ok")]),
    fauxAssistantMessage([fauxText("noted")]),
  ]);

  await page.locator("#prompt-text").fill("start a docs thread");
  await page.locator("#prompt-text").press("Enter");

  await page
    .locator('#chat li[data-role="assistant"]')
    .getByText(/^(ok|noted)$/)
    .first()
    .waitFor();

  const card = page.locator('#chat [aria-label="Thread Docs"]');
  await card.getByRole("link", { name: "Open Docs fullscreen" }).waitFor();
  expect(await page.locator("#chat").getByText("start_thread").count()).toBe(0);

  const row = rail.getByRole("listitem", { name: "Docs" });
  await row.getByText(/^e2e · /).waitFor();
  await row.getByRole("button", { name: "Actions for Docs" }).click();

  await page.getByRole("menuitemradio", { name: "Ready for review" }).click();

  const review = rail
    .getByRole("region", { name: "Review" })
    .getByRole("listitem", { name: "Docs" });

  await review.waitFor();
  expect(await rail.getByRole("region", { name: "Needs you" }).count()).toBe(0);

  // The thread's reply wakes the coordinator, and both take scripted replies
  // that later tests would otherwise lose to them.
  await review.getByRole("link").click();

  const side = page.getByRole("complementary", { name: "Docs" });
  await side.locator('li[data-role="assistant"]').getByText(/^ok$/).waitFor();

  expect(
    await page
      .locator("#project-nav")
      .getByRole("link", { name: /^Site docs/ })
      .getAttribute("aria-current"),
  ).toBe("page");

  const threadId = new URL(page.url()).hash.split("/").at(-1) ?? "";

  expect(
    await page.locator(`#sessions li[data-id="${threadId}"]`).count(),
  ).toBe(0);

  await page.goto(server.url.href);
  await page.goto(`${server.url.href}#${threadId}`);
  await side.waitFor();
  expect(new URL(page.url()).hash).toEndWith(`/${threadId}`);

  await side.getByRole("button", { name: "Open fullscreen" }).click();
  await page.getByRole("heading", { level: 1, name: /Docs$/ }).waitFor();
  await side.waitFor({ state: "detached" });

  await page
    .getByRole("button", { name: "Show beside the coordinator" })
    .click();

  await side.getByRole("button", { name: "Back to threads" }).click();
  await side.waitFor({ state: "detached" });
  await rail.getByRole("listitem", { name: "Docs" }).waitFor();
  await page.setViewportSize({ width: 390, height: 780 });
  await rail.getByRole("listitem", { name: "Docs" }).getByRole("link").click();
  await side.waitFor();
  await side.getByRole("button", { name: "Back to threads" }).click();
  await rail.getByRole("button", { name: "Hide threads" }).click();
  await page.setViewportSize({ width: 1280, height: 720 });

  while (faux.state.callCount < calls + 4) {
    await Bun.sleep(20);
  }

  await page
    .locator('#chat li[data-role="notice"]')
    .getByRole("link", { name: "Docs" })
    .first()
    .waitFor();

  expect(
    await page
      .locator('#chat li[data-role="user"]')
      .filter({ hasText: "[Project notice]" })
      .count(),
  ).toBe(0);

  faux.setResponses([
    fauxAssistantMessage([fauxText(`See [Docs](thread:${threadId}).`)]),
  ]);

  await page.locator("#prompt-text").fill("where are the docs?");
  await page.locator("#prompt-text").press("Enter");

  const chip = page
    .locator('#chat li[data-role="assistant"]')
    .getByRole("link", { name: /^Docs/ });

  await chip.getByText("Ready for review").waitFor();
  await chip.click();
  await side.waitFor();
  await side.getByRole("button", { name: "Back to threads" }).click();

  const pluginNav = page.locator("#plugin-nav");

  await pluginNav.getByRole("button", { name: "More" }).click();
  await pluginNav.getByRole("link", { name: "Library" }).click();

  await page.getByText("No files yet.").waitFor();

  await page.getByLabel("Upload files").setInputFiles({
    name: "brief.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("the brief\n"),
  });

  await page.getByRole("link", { name: "brief.txt" }).waitFor();
  await page.getByText(/user:\S+ wrote brief\.txt \(10 bytes\)$/).waitFor();

  const nav = page.locator("#project-nav").getByRole("link", { name: /^Site/ });
  await nav.click();
  await page.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page.locator("#status", { hasText: "archived" }).waitFor();
  await nav.waitFor({ state: "detached" });

  await rail
    .getByRole("listitem", { name: "Docs" })
    .getByText(/^Archived · /)
    .waitFor();

  await page
    .locator("#plugin-nav")
    .getByRole("link", { name: "Projects" })
    .click();

  await page
    .locator("section", {
      has: page.getByRole("heading", { name: "Archived" }),
    })
    .getByRole("button", { name: /^Site docs/ })
    .click();

  await page.getByRole("button", { name: "Project settings" }).click();
  await settings.getByRole("button", { name: "Unarchive Project" }).click();
  await nav.waitFor();

  await rail
    .getByRole("listitem", { name: "Docs" })
    .getByText(/^Archived · /)
    .waitFor({ state: "detached" });

  page.once("dialog", async (dialog) => dialog.accept());
  await settings.getByRole("button", { name: "Archive Project" }).click();
  await nav.waitFor({ state: "detached" });
}, 30_000);

test("shows a Project made elsewhere on the open Projects page", async () => {
  let made = false;
  const { promise: listed, resolve: list } = Promise.withResolvers();

  await page.route("**/api/plugins/projects/projects", async (route) =>
    route.fulfill({
      json: made
        ? [
            {
              id: "elsewhere",
              name: "Made elsewhere",
              threads: 0,
              needsYou: 0,
              repositories: 1,
              coordinatorState: "idle",
            },
          ]
        : [],
    }),
  );

  await page.route("**/api/changes", async (route) => {
    await listed;
    made = true;

    await route.fulfill({
      contentType: "text/event-stream",
      body: `retry: 60000\ndata: ${JSON.stringify({ topic: "projects.projects" })}\n\n`,
    });
  });

  await page.goto(server.url.href);

  await page
    .locator("#plugin-nav")
    .getByRole("link", { name: "Projects" })
    .click();

  const pluginPage = page.locator("#plugin-page");
  await pluginPage.getByText("No Projects yet.").waitFor();
  list(undefined);

  await pluginPage
    .getByRole("button", { name: /^Made elsewhere/ })
    .waitFor({ timeout: 2000 });

  await page.unroute("**/api/changes");
  await page.unroute("**/api/plugins/projects/projects");
});

test("shows a plugin page's failure without taking the app down", async () => {
  await page.route("**/api/plugins/projects/projects", async (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "projects store is unreadable" }),
    }),
  );

  await page.goto(server.url.href);

  await page
    .locator("#plugin-nav")
    .getByRole("link", { name: "Projects" })
    .click();

  const pluginPage = page.locator("#plugin-page");

  await pluginPage
    .getByRole("alert")
    .filter({ hasText: "projects store is unreadable" })
    .waitFor();

  await page
    .locator("#plugin-nav")
    .getByRole("alert")
    .filter({ hasText: "projects store is unreadable" })
    .waitFor();

  await page.unroute("**/api/plugins/projects/projects");
  await pluginPage.getByRole("button", { name: "Try again" }).click();
  await page.getByRole("heading", { name: "New Project" }).waitFor();
  await page.getByRole("button", { name: "New session" }).waitFor();
});

test("keeps a plugin's newest list when an older load answers last", async () => {
  const projects = (name: string): object[] => [
    {
      id: name,
      name,
      needsYou: 0,
      repositories: 1,
      coordinatorState: "idle",
    },
  ];

  const loads: Route[] = [];
  const { promise: watching, resolve: watched } = Promise.withResolvers();

  await page.route("**/api/plugins/projects/projects", async (route) => {
    loads.push(route);
    watched(undefined);

    if (loads.length === 2) {
      await route.fulfill({ json: projects("Newer") });
    }
  });

  // One change arrives while the list's first load is still on its way.
  await page.route("**/api/changes", async (route) => {
    await watching;

    await route.fulfill({
      contentType: "text/event-stream",
      body: `retry: 60000\ndata: ${JSON.stringify({ topic: "sessions" })}\n\n`,
    });
  });

  await page.goto(server.url.href);

  const nav = page.locator("#project-nav");
  await nav.getByRole("link", { name: /^Newer/ }).waitFor();
  await loads[0]?.fulfill({ json: projects("Older") });
  await page.waitForTimeout(500);

  const shown = await nav.getByRole("link").allTextContents();

  expect(shown.map((text) => text.split("1 repository")[0])).toEqual(["Newer"]);

  await page.unroute("**/api/changes");
  await page.unroute("**/api/plugins/projects/projects");
});

test("attaches an image to a message and shows it in the chat", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("a tiny pixel")])]);
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  await page.getByLabel("Attach images").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    ),
  });

  await page.getByRole("img", { name: "pixel.png" }).waitFor();
  await page.locator("#prompt-text").fill("what is this?");
  await page.locator("#prompt-text").press("Enter");

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "a tiny pixel" })
    .waitFor();

  expect(await page.getByRole("img", { name: "pixel.png" }).count()).toBe(0);

  await page.reload();

  await page
    .locator('#chat li[data-role="user"]', { hasText: "what is this?" })
    .getByRole("img", { name: "Image 1 sent with this message" })
    .waitFor();
}, 30_000);

test("picks a slash command from the composer's menu", async () => {
  await mkdir(join(root, ".pi", "prompts"), { recursive: true });

  await writeFile(
    join(root, ".pi", "prompts", "review.md"),
    "---\ndescription: Review the diff\n---\nReview the current diff.\n",
  );

  faux.setResponses([fauxAssistantMessage([fauxText("reviewed")])]);
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();
  await trustRepository();

  const box = page.locator("#prompt-text");
  await box.pressSequentially("/rev");

  await page
    .getByRole("listbox", { name: "Commands" })
    .getByRole("option", { name: /\/review\s+Review the diff/ })
    .waitFor();

  await box.press("Enter");
  expect(await box.inputValue()).toBe("/review ");
  await box.press("Enter");

  await page
    .locator('#chat li[data-role="user"]', {
      hasText: "Review the current diff.",
    })
    .waitFor();
}, 30_000);

test("mentions a workspace file from the composer's menu", async () => {
  const project = join(root, "mentions");
  execFileSync("git", ["init", "--quiet", project]);
  await writeFile(join(project, "mention-target.md"), "notes\n");
  faux.setResponses([fauxAssistantMessage([fauxText("read it")])]);
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, project);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  const box = page.locator("#prompt-text");
  await box.pressSequentially("summarize @mention-ta");

  await page
    .getByRole("listbox", { name: "Files" })
    .getByRole("option", { name: "@mention-target.md" })
    .click();

  expect(await box.inputValue()).toBe("summarize @mention-target.md ");
  await box.press("Enter");

  await page
    .locator('#chat li[data-role="user"]', {
      hasText: "summarize @mention-target.md",
    })
    .waitFor();
}, 30_000);

test("creates a pull request from the Changes panel", async () => {
  const project = join(root, "widgets");
  const remote = join(root, "widgets.git");
  const bin = join(root, "bin");
  const github = "https://github.com/acme/widgets.git";

  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: project, encoding: "utf8" });

  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", project]);
  await writeFile(join(project, "README.md"), "widgets\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first");
  git("config", `url.${remote}.insteadOf`, github);
  git("remote", "add", "origin", github);
  git("push", "--quiet", "origin", "main");

  await mkdir(bin);

  await writeFile(
    join(bin, "gh"),
    "#!/bin/sh\necho https://github.com/acme/widgets/pull/12\n",
    { mode: 0o755 },
  );

  const saved = { ...process.env };

  Object.assign(process.env, {
    PATH: `${bin}:${saved["PATH"] ?? ""}`,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  });

  try {
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("write", { path: "widget.ts", content: "export {};\n" }),
      ]),
      fauxAssistantMessage([fauxText("added the widget")]),
      fauxAssistantMessage([fauxText("Add a widget\n\nStarts the module.")]),
    ]);

    await page.goto(server.url.href);
    await page.getByRole("button", { name: "New session" }).click();
    const form = page.locator("form#create");

    await pickWorkspace(form, project, false);
    await form.getByRole("button", { name: "Start session" }).click();
    await page.locator("#status", { hasText: "idle" }).waitFor();

    await page.locator("#prompt-text").fill("add a widget");
    await page.locator("#prompt-text").press("Enter");

    await page.getByRole("button", { name: "Diff, 1 file changed" }).click();
    const changes = page.getByRole("dialog", { name: "Changes" });
    await changes.getByText("Changes (1 file)").waitFor();

    await changes
      .getByRole("button", { name: "More ways to create a PR" })
      .click();

    await changes.getByRole("menuitem", { name: "Create draft PR" }).waitFor();
    await page.keyboard.press("Escape");

    await changes
      .getByRole("button", { name: "Create PR", exact: true })
      .click();

    const view = changes.getByRole("link", { name: "View PR" });
    await view.waitFor();

    expect(await view.getAttribute("href")).toBe(
      "https://github.com/acme/widgets/pull/12",
    );

    const branch = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short) %(subject)", "refs/heads"],
      { cwd: remote, encoding: "utf8" },
    );

    expect(branch).toContain("Add a widget");
  } finally {
    process.env = saved;
  }
}, 30_000);

test("follows the system theme until a theme is picked, and keeps the pick", async () => {
  const theme = async (): Promise<string | null> =>
    page.locator("html").getAttribute("data-theme");

  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(server.url.href);
  expect(await theme()).toBe("light");

  await page.emulateMedia({ colorScheme: "dark" });

  await page.locator('html[data-theme="dark"]').waitFor({ state: "attached" });

  await page.getByRole("button", { name: /^Theme: system/ }).click();
  expect(await theme()).toBe("light");
  await page.reload();
  expect(await theme()).toBe("light");

  await page.getByRole("button", { name: /^Theme: light/ }).click();
  await page.getByRole("button", { name: /^Theme: dark/ }).click();
  await page.getByRole("button", { name: /^Theme: system/ }).waitFor();
  expect(await theme()).toBe("dark");
});

test("queues a message while Pi works, takes one back and sends one now", async () => {
  let release = (): void => undefined;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  faux.setResponses([
    async () => {
      await gate;

      return fauxAssistantMessage([fauxText("finally done")]);
    },
  ]);

  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  const box = page.locator("#prompt-text");
  await box.fill("start");
  await box.press("Enter");
  await page.locator("#status", { hasText: "running" }).waitFor();

  await page.getByText("Enter queues").waitFor();
  await box.fill("not yet");
  await box.press("Enter");
  const takeBack = page.getByRole("button", { name: 'Take back "not yet"' });
  await takeBack.click();
  await takeBack.waitFor({ state: "detached" });
  expect(await box.inputValue()).toBe("not yet");

  await box.fill("right away");
  await box.press("Enter");
  await page.getByRole("button", { name: 'Send "right away" now' }).click();

  await page
    .locator("p", { hasText: "right away" })
    .getByText("Steering")
    .waitFor();

  release();

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "finally done" })
    .waitFor();
}, 30_000);

test("sends comments on diff lines to Pi as one message", async () => {
  const project = join(root, "review");
  execFileSync("git", ["init", "--quiet", project]);
  await writeFile(join(project, "notes.txt"), "old notes\n");
  execFileSync("git", ["add", "."], { cwd: project });

  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first"],
    { cwd: project },
  );

  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("write", { path: "notes.txt", content: "new notes\n" }),
    ]),
    fauxAssistantMessage([fauxText("rewrote them")]),
    fauxAssistantMessage([fauxText("will fix")]),
  ]);

  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, project);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  await page.locator("#prompt-text").fill("rewrite the notes");
  await page.locator("#prompt-text").press("Enter");

  await page.getByRole("button", { name: "Diff, 1 file changed" }).click();
  const changes = page.getByRole("dialog", { name: "Changes" });
  await changes.getByText("Changes (1 file)").waitFor();

  await changes
    .getByRole("button", { name: "Comment on notes.txt line 1" })
    .click();

  const comment = changes.getByRole("textbox", {
    name: "Comment on notes.txt line 1",
  });

  await comment.fill("keep the old wording");
  await comment.press("Enter");
  await changes.getByText("1 comment on the diff").waitFor();
  await changes.getByRole("button", { name: "Send to Pi" }).click();

  await page
    .locator('#chat li[data-role="user"]', {
      hasText: "notes.txt:1`: keep the old wording",
    })
    .waitFor();

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "will fix" })
    .waitFor();

  await changes
    .getByText("1 comment on the diff")
    .waitFor({ state: "detached" });
}, 30_000);

test("keeps the closed sessions drawer out of reach on a phone", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(server.url.href);

  const newSession = page.getByRole("button", { name: "New session" });
  await page.getByRole("button", { name: "Open sessions" }).click();
  await newSession.waitFor();

  await page.getByRole("link", { name: "Projects" }).click();
  await newSession.waitFor({ state: "hidden" });

  expect(await newSession.count()).toBe(0);

  await page.setViewportSize({ width: 1280, height: 720 });
});

test("moves focus into the sessions drawer, closes it with Escape and gives focus back", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(server.url.href);

  const menu = page.getByRole("button", { name: "Open sessions" });
  const newSession = page.getByRole("button", { name: "New session" });
  await menu.click();
  await newSession.waitFor();

  expect(await page.locator("aside :focus").count()).toBe(1);

  await page.keyboard.press("Escape");
  await newSession.waitFor({ state: "hidden" });

  expect(await page.locator(":focus").getAttribute("aria-label")).toBe(
    "Open sessions",
  );

  await page.setViewportSize({ width: 1280, height: 720 });
});

test("opens the sessions drawer without sliding when motion is reduced", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "Open sessions" }).click();

  expect((await page.locator("aside").boundingBox())?.x).toBe(0);

  await page.emulateMedia({ reducedMotion: null });
  await page.setViewportSize({ width: 1280, height: 720 });
});

test("switches a session's model and reasoning level from the composer", async () => {
  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  const composer = page.locator("form#prompt");
  const model = composer.getByRole("button", { name: "Model" });
  const reasoning = composer.getByRole("radiogroup", { name: "Reasoning" });

  await model.filter({ hasText: "faux-1" }).waitFor();
  await model.click();
  expect(await reasoning.count()).toBe(0);

  await composer.getByRole("option", { name: "faux-deep" }).click();
  await model.click();
  await reasoning.getByRole("radio", { name: "high", exact: true }).click();
  await model.filter({ hasText: "faux-deep · high" }).waitFor();

  let asked: { model: string; reasoning: unknown } | undefined;

  faux.setResponses([
    (_context, options, _state, used) => {
      asked = { model: used.id, reasoning: options?.reasoning };

      return fauxAssistantMessage([fauxText("thought hard")]);
    },
  ]);

  await page.locator("#prompt-text").fill("think");
  await page.locator("#prompt-text").press("Enter");

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "thought hard" })
    .waitFor();

  expect(asked).toEqual({ model: "faux-deep", reasoning: "high" });
}, 30_000);

test("starts a session at the reasoning level picked in the New session form", async () => {
  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Model" }).click();
  await form.getByRole("combobox", { name: "Model" }).fill("faux/faux-deep");
  await form.getByRole("combobox", { name: "Model" }).press("Enter");
  await form.getByRole("button", { name: "Model" }).click();
  await form.getByRole("radio", { name: "high", exact: true }).click();
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  const composer = page.locator("form#prompt");

  await composer
    .getByRole("button", { name: "Model" })
    .filter({ hasText: "faux-deep · high" })
    .waitFor();
}, 30_000);

test("runs Pi's built-in commands from the composer", async () => {
  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  const box = page.locator("#prompt-text");

  await box.fill("/");
  await page.getByRole("option", { name: /\/session/ }).waitFor();

  await box.fill("/name Release prep");
  await box.press("Enter");
  await page.getByRole("heading", { name: "Release prep" }).waitFor();

  await box.fill("/session");
  await box.press("Enter");
  expect(await box.inputValue()).toBe("/session ");
  await box.press("Enter");

  await page
    .locator("#chat", { hasText: "0 user and 0 assistant messages" })
    .waitFor();

  expect(await page.locator('#chat li[data-role="user"]').count()).toBe(0);
}, 30_000);

test("logs in to a provider from the model menu", async () => {
  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  const composer = page.locator("form#prompt");

  await composer.getByRole("button", { name: "Model" }).click();
  await composer.getByRole("button", { name: "Log in to a provider…" }).click();
  await page.getByRole("button", { name: "Sign in with an API key" }).click();
  await page.getByRole("button", { name: "OpenAI", exact: true }).click();
  await page.locator("input[type=password]").fill("sk-e2e");
  await page.getByRole("button", { name: "Submit" }).click();

  await page
    .locator("#chat", { hasText: "Saved the API key for OpenAI." })
    .waitFor();

  await composer.getByRole("button", { name: "Model" }).click();
  await composer.getByText("openai", { exact: true }).waitFor();
  await page.keyboard.press("Escape");

  const box = page.locator("#prompt-text");

  await box.fill("/logout openai");
  await box.press("Enter");
  await page.locator("#chat", { hasText: "Logged out of OpenAI." }).waitFor();
}, 30_000);

test("draws an extension's widget and footer as Pi's TUI does, at the composer's width", async () => {
  const folder = join(root, "focus");
  await mkdir(join(folder, ".pi", "extensions"), { recursive: true });

  await writeFile(
    join(folder, ".pi", "extensions", "focus.ts"),
    `export default (pi) => {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("plan", "planning");
    ctx.ui.setWidget("focus", (tui, theme) => ({
      render: (width) => [theme.bold("FOCUS"), theme.fg("accent", "=".repeat(width))],
      invalidate: () => {},
    }));
    ctx.ui.setFooter((tui, theme, footer) => ({
      render: () => ["status: " + [...footer.getExtensionStatuses().values()].join(" ")],
      invalidate: () => {},
    }));
  });
};
`,
  );

  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, folder);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();
  await trustRepository();

  await page.locator("footer", { hasText: "status: planning" }).waitFor();

  const widget = page.locator("pre", { hasText: "FOCUS" });
  const focus = widget.locator("span", { hasText: "FOCUS" });
  const rule = widget.locator("span", { hasText: "===" });

  expect(await focus.getAttribute("style")).toContain("font-weight: bold");

  // The rule is as wide as the host was told, so it fills the widget.
  const filled = async (): Promise<number> => {
    const [box, line] = await Promise.all([
      widget.boundingBox(),
      rule.boundingBox(),
    ]);

    return (line?.width ?? 0) / (box?.width ?? 1);
  };

  const columns = async (): Promise<number> =>
    (await rule.textContent())?.length ?? 0;

  const settled = async (): Promise<number> => {
    let last = -1;

    for (;;) {
      await Bun.sleep(500);
      const now = await columns();

      if (now === last) {
        return now;
      }

      last = now;
    }
  };

  const wide = await settled();
  expect(await filled()).toBeGreaterThan(0.85);
  expect(await filled()).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 700, height: 800 });

  expect(await settled()).toBeLessThan(wide);
  expect(await filled()).toBeGreaterThan(0.85);
  expect(await filled()).toBeLessThanOrEqual(1);

  // The widgets mount after the chat scrolls to its end, and still leave the
  // last reply in view.
  faux.setResponses([
    fauxAssistantMessage([fauxText(Array(40).fill("line").join("\n\n"))]),
  ]);

  await page.locator("#prompt-text").fill("talk a lot");
  await page.locator("#prompt-text").press("Enter");
  await page.locator("#status", { hasText: "idle" }).waitFor();
  await page.reload();
  await page.locator("footer", { hasText: "status: planning" }).waitFor();
  await Bun.sleep(500);

  expect(
    await page.evaluate(
      "(() => { const box = document.querySelector('#chat').parentElement; return box.scrollHeight - box.scrollTop - box.clientHeight; })()",
    ),
  ).toBeLessThan(2);

  await page.setViewportSize({ width: 1280, height: 720 });
}, 30_000);

test("draws a subagent run as a card in the chat, with a chip while it runs", async () => {
  const folder = join(root, "delegating");
  await mkdir(join(folder, ".pi", "extensions"), { recursive: true });

  // Stands in for pi-subagents, which replaces the plugin's copy: it reports
  // the run in pi-subagents' formats for hosts.
  await writeFile(
    join(folder, ".pi", "extensions", "subagents.ts"),
    `const snapshot = (state) => [
  "PI_SUBAGENT_ASYNC_JSON:" + JSON.stringify({
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    runs: [{
      id: "r1", kind: "subagent", label: "worker", state, startedAt: Date.now() - 5000,
      children: [{ id: "step:0", kind: "step", label: "worker", state, agent: "worker",
        model: "faux/faux-1", activity: { toolCount: 3, currentTool: "read" } }],
    }],
  }),
];

export default (pi) => {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegates a task",
    parameters: { type: "object", properties: {} },
    execute: async (_id, _params, _signal, _update, ctx) => {
      ctx.ui.setWidget("subagent-async", snapshot("running"));
      ctx.ui.setWidget("subagent-fleet-status", ["1 active agent"], { placement: "belowEditor" });

      return { content: [{ type: "text", text: "Async: worker [r1]" }], details: { asyncId: "r1" } };
    },
  });

  pi.registerCommand("subagents-inspect-rpc", {
    handler: async (args, ctx) => {
      const [requestId] = args.split(" ");
      const reply = { kind: "pi-subagents.inspect-reply", version: 1, requestId,
        messages: [{ role: "assistant", kind: "text", text: "Reading the tests" }] };

      ctx.ui.setWidget("subagent-inspect", ["PI_SUBAGENT_INSPECT_JSON:" + JSON.stringify(reply)]);
      ctx.ui.setWidget("subagent-inspect", undefined);
    },
  });

  pi.registerCommand("finish-run", {
    handler: async (_args, ctx) => {
      ctx.ui.setWidget("subagent-fleet-status", undefined);
      ctx.ui.setWidget("subagent-async", undefined);
      pi.sendMessage({
        customType: "subagent-notify",
        content: "Background task completed: **worker**",
        display: true,
        details: { runs: [{ agent: "worker", status: "completed", runId: "r1", durationMs: 65000 }] },
      });
    },
  });
};
`,
  );

  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("subagent", { agent: "worker", task: "Check the tests" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("Started a worker")]),
  ]);

  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await pickWorkspace(form, folder);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();
  await trustRepository();

  const box = page.locator("#prompt-text");
  await box.fill("check the tests in the background");
  await box.press("Enter");

  const card = page.locator('#chat li[data-role="card"]', {
    hasText: "Check the tests",
  });

  await card.getByText("Running · 3 tools").waitFor();
  await card.getByText("faux/faux-1 · running read").waitFor();

  await page.getByRole("button", { name: "1 subagent running" }).waitFor();

  await card.getByRole("button", { name: /worker/ }).click();
  await card.getByText("Reading the tests").waitFor();

  await box.fill("/finish-run");
  await box.press("Enter");
  expect(await box.inputValue()).toBe("/finish-run ");
  await box.press("Enter");

  await card.getByText("Done · 3 tools · 1m 05s").waitFor();

  await page
    .getByRole("button", { name: "1 subagent running" })
    .waitFor({ state: "hidden" });

  await page.reload();

  await page
    .locator('#chat li[data-role="card"]', { hasText: "Check the tests" })
    .getByText("Done · 1m 05s")
    .waitFor();
}, 30_000);

test("signs out and back in with the password", async () => {
  await page.goto(server.url.href);
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Sign in" }).waitFor();

  await page.getByLabel("Name").fill("pedro");
  await page.getByLabel("Password").fill("wrong password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("alert").filter({ hasText: "Wrong name" }).waitFor();

  await page.getByLabel("Password").fill("correct horse");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "New session" }).waitFor();
});

test("opens a page the Session opened in a browser through its preview", async () => {
  const app = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request): Response =>
      request.headers.get("host") === `localhost:${String(app.port)}`
        ? new Response("<h1>plan from the app</h1>", {
            headers: { "content-type": "text/html" },
          })
        : new Response("wrong host", { status: 403 }),
  });

  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("bash", {
          command: `"$BROWSER" http://localhost:${String(app.port)}/`,
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("opened the plan")]),
  ]);

  // Previews live on subdomains, which an IP address doesn't have.
  const site = `http://localhost:${server.url.port}`;
  const context = await browser.newContext();

  await context.request.post(`${site}/api/auth/login`, {
    data: { name: "pedro", password: "correct horse" },
  });

  const [environment] = (await (
    await context.request.get(`${site}/api/environments`)
  ).json()) as { id: string }[];

  const { id } = (await (
    await context.request.post(`${site}/api/sessions`, {
      data: {
        environment: environment?.id,
        workspace: { kind: "folder", path: root },
      },
    })
  ).json()) as { id: string };

  const tab = await context.newPage();
  await tab.goto(`${site}/#${id}`);
  await tab.locator("#status", { hasText: "idle" }).waitFor();
  await tab.locator("#prompt-text").fill("open the plan");
  await tab.locator("#prompt-text").press("Enter");

  const pages = tab.getByRole("list", { name: "Opened pages" });
  await pages.waitFor();

  const [preview] = await Promise.all([
    context.waitForEvent("page"),
    pages.getByRole("link", { name: "Open" }).click(),
  ]);

  await preview.getByRole("heading", { name: "plan from the app" }).waitFor();

  expect(new URL(preview.url()).hostname).toBe(
    `${String(app.port)}--${id}.localhost`,
  );

  await pages.getByRole("button", { name: "Dismiss" }).click();
  await pages.waitFor({ state: "detached" });

  await context.close();
  await app.stop(true);
});
