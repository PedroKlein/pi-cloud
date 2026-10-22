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
import { type Browser, chromium, type Page } from "playwright-core";
import { serve } from "./serve";

let root: string;
let server: ReturnType<typeof serve>;
let browser: Browser;
let page: Page;

const faux = fauxProvider({
  models: [{ id: "faux-1" }, { id: "faux-deep", reasoning: true }],
});

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pi-cloud-e2e-")));

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
      provider: "e2e",
      dataDir: join(root, "e2e"),
      agentDir: join(root, "pi"),
      extensionPaths: [],
      folders: [root],
      models: { runtime, model: faux.getModel() },
    },
    log: () => undefined,
  });

  browser = await chromium.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(10_000);
});

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

  await form.getByRole("radio", { name: /^e2e/ }).check();

  await form.locator("[name=kind]").selectOption("folder");
  await form.locator("[name=location]").fill(root);
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
}, 30_000);

test("starts a session with the task from the New session form", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("on it")])]);
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await form.getByRole("radio", { name: /^e2e/ }).check();
  await form.locator("[name=kind]").selectOption("folder");
  await form.locator("[name=location]").fill(root);

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

test("archives a session, shows it only with archived sessions and unarchives it", async () => {
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await form.getByRole("radio", { name: /^e2e/ }).check();

  await form.locator("[name=kind]").selectOption("folder");
  await form.locator("[name=location]").fill(root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();
  const id = new URL(page.url()).hash.slice(1);
  const item = page.locator(`#sessions li[data-id="${id}"]`);
  await item.waitFor();

  await page.getByRole("button", { name: "Archive" }).click();
  await page.locator("#status", { hasText: "archived" }).waitFor();
  await page.locator("#prompt").waitFor({ state: "hidden" });
  await page.reload();
  await page.locator("#status", { hasText: "archived" }).waitFor();

  await item.waitFor({ state: "detached" });
  await page.getByLabel("Show archived").check();
  await item.waitFor();
  await page.getByRole("button", { name: "Unarchive" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  expect(new URL(page.url()).hash.slice(1)).toBe(id);
  expect(await page.locator("#prompt").isVisible()).toBe(true);
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

  await form.getByRole("radio", { name: /^e2e/ }).check();

  await form.locator("[name=kind]").selectOption("folder");
  await form.locator("[name=location]").fill(root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();
  const id = new URL(page.url()).hash.slice(1);
  const item = page.locator(`#sessions li[data-id="${id}"]`);

  await page.getByRole("button", { name: "Search" }).click();
  const search = page.getByLabel("Search sessions");
  await search.fill("no-such-session");
  await item.waitFor({ state: "detached" });
  await page.getByText("No sessions match.").waitFor();
  await search.fill("pi-cloud-e2e");
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

  await form.getByRole("radio", { name: /^e2e/ }).check();

  await form.locator("[name=kind]").selectOption("folder");
  await form.locator("[name=location]").fill(root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  await page.locator("#prompt-text").fill("pick a size");
  await page.locator("#prompt-text").press("Enter");

  const card = page.locator('[data-role="prompt"]');
  await card.getByRole("heading", { level: 2, name: "Which size?" }).waitFor();
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

  const work = page.locator('#chat li[data-role="work"]');
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

  await form.getByRole("radio", { name: /^e2e/ }).check();

  await form.locator("[name=kind]").selectOption("folder");
  await form.locator("[name=location]").fill(root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  await page.locator("#prompt-text").fill("write notes");
  await page.locator("#prompt-text").press("Enter");

  const changes = page.locator('#plugin-panels [data-plugin="changes"]');
  await changes.getByText("Changes (1 file)").click();
  await changes.locator("tr", { hasText: "new notes" }).waitFor();

  await page
    .locator('#plugin-header [data-plugin="usage"]', { hasText: "out" })
    .waitFor();
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
  await form.getByLabel("Repository URLs, one per line").fill(repository);
  await form.getByRole("button", { name: "New Project" }).click();
  await page.getByRole("heading", { level: 1, name: "Site" }).waitFor();
  await page.getByRole("heading", { level: 2, name: "Threads" }).waitFor();
  await page.getByText("No threads yet.").waitFor();

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

  const coordinator = page.getByRole("region", { name: "Coordinator" });
  await coordinator.getByText("No reply yet.").waitFor();

  await coordinator
    .getByLabel("Message the coordinator")
    .fill("start a docs thread");

  await coordinator.getByLabel("Message the coordinator").press("Enter");

  await coordinator.getByText(/^(ok|noted)$/).waitFor();

  const card = page
    .getByRole("region", { name: "Working" })
    .getByRole("article", { name: "Docs" });

  await card.getByText(/^e2e · /).waitFor();

  // The thread's reply wakes the coordinator, and both take scripted replies
  // that later tests would otherwise lose to them.
  await card.getByRole("button", { name: "Docs" }).click();

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "ok" })
    .waitFor();

  while (faux.state.callCount < calls + 4) {
    await Bun.sleep(20);
  }

  await page
    .locator("#plugin-nav")
    .getByRole("link", { name: "Library" })
    .click();

  await page.getByText("No files yet.").waitFor();

  await page.getByLabel("Upload files").setInputFiles({
    name: "brief.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("the brief\n"),
  });

  await page.getByRole("link", { name: "brief.txt" }).waitFor();
  await page.getByText("user:local wrote brief.txt (10 bytes)").waitFor();
}, 30_000);

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

test("attaches an image to a message and shows it in the chat", async () => {
  faux.setResponses([fauxAssistantMessage([fauxText("a tiny pixel")])]);
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await form.getByRole("radio", { name: /^e2e/ }).check();

  await form.locator("[name=kind]").selectOption("folder");
  await form.locator("[name=location]").fill(root);
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

  await form.getByRole("radio", { name: /^e2e/ }).check();

  await form.locator("[name=kind]").selectOption("folder");
  await form.locator("[name=location]").fill(root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

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

  await form.getByRole("radio", { name: /^e2e/ }).check();

  await form.locator("[name=kind]").selectOption("folder");
  await form.locator("[name=location]").fill(project);
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

    await form.getByRole("radio", { name: /^e2e/ }).check();

    await form.locator("[name=kind]").selectOption("worktree");
    await form.locator("[name=location]").fill(project);
    await form.getByRole("button", { name: "Start session" }).click();
    await page.locator("#status", { hasText: "idle" }).waitFor();

    await page.locator("#prompt-text").fill("add a widget");
    await page.locator("#prompt-text").press("Enter");

    const changes = page.locator('#plugin-panels [data-plugin="changes"]');
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

test("takes a queued message back into the composer", async () => {
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

  await form.getByRole("radio", { name: /^e2e/ }).check();

  await form.locator("[name=kind]").selectOption("folder");
  await form.locator("[name=location]").fill(root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  const box = page.locator("#prompt-text");
  await box.fill("start");
  await box.press("Enter");
  await page.locator("#status", { hasText: "running" }).waitFor();

  await box.fill("not yet");
  await box.press("Alt+Enter");
  const takeBack = page.getByRole("button", { name: 'Take back "not yet"' });
  await takeBack.click();
  await takeBack.waitFor({ state: "detached" });
  expect(await box.inputValue()).toBe("not yet");

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

  await form.getByRole("radio", { name: /^e2e/ }).check();

  await form.locator("[name=kind]").selectOption("folder");
  await form.locator("[name=location]").fill(project);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  await page.locator("#prompt-text").fill("rewrite the notes");
  await page.locator("#prompt-text").press("Enter");

  const changes = page.locator('#plugin-panels [data-plugin="changes"]');
  await changes.getByText("Changes (1 file)").click();

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

test("switches a session's model and reasoning level from the composer", async () => {
  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await form.getByRole("radio", { name: /^e2e/ }).check();

  await form.locator("[name=kind]").selectOption("folder");
  await form.locator("[name=location]").fill(root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  const composer = page.locator("form#prompt");
  const model = composer.getByLabel("Model");
  const reasoning = composer.getByLabel("Reasoning");

  expect(await model.inputValue()).toBe("faux/faux-1");
  expect(await reasoning.count()).toBe(0);

  await model.selectOption("faux/faux-deep");
  await reasoning.waitFor();
  await reasoning.selectOption("high");

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

  await form.getByRole("radio", { name: /^e2e/ }).check();

  await form.locator("[name=kind]").selectOption("folder");
  await form.locator("[name=location]").fill(root);
  await form.locator("[name=model]").fill("faux/faux-deep");
  await form.getByLabel("Reasoning").selectOption("high");
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  const composer = page.locator("form#prompt");

  await composer
    .getByLabel("Reasoning")
    .and(page.locator(":has(option:checked[value=high])"))
    .waitFor();

  expect(await composer.getByLabel("Model").inputValue()).toBe(
    "faux/faux-deep",
  );
}, 30_000);

test("runs Pi's built-in commands from the composer", async () => {
  await page.goto(server.url.href);
  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await form.getByRole("radio", { name: /^e2e/ }).check();

  await form.locator("[name=kind]").selectOption("folder");
  await form.locator("[name=location]").fill(root);
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

  await form.getByRole("radio", { name: /^e2e/ }).check();

  await form.locator("[name=kind]").selectOption("folder");
  await form.locator("[name=location]").fill(root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  const model = page.locator("form#prompt").getByLabel("Model");

  await model.selectOption({ label: "Log in to a provider…" });
  await page.getByRole("button", { name: "Sign in with an API key" }).click();
  await page.getByRole("button", { name: "OpenAI", exact: true }).click();
  await page.locator("input[type=password]").fill("sk-e2e");
  await page.getByRole("button", { name: "Submit" }).click();

  await page
    .locator("#chat", { hasText: "Saved the API key for OpenAI." })
    .waitFor();

  await model.locator("option[value^='openai/']").first().waitFor({
    state: "attached",
  });

  const box = page.locator("#prompt-text");

  await box.fill("/logout openai");
  await box.press("Enter");
  await page.locator("#chat", { hasText: "Logged out of OpenAI." }).waitFor();
}, 30_000);
