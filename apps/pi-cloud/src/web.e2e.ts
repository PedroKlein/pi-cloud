import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
const faux = fauxProvider();

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

  await form
    .locator("[name=environment]")
    .selectOption({ label: "e2e (e2e, online)" });

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

test("archives a session, shows it only with archived sessions and unarchives it", async () => {
  await page.goto(server.url.href);

  await page.getByRole("button", { name: "New session" }).click();
  const form = page.locator("form#create");

  await form
    .locator("[name=environment]")
    .selectOption({ label: "e2e (e2e, online)" });

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

  await form
    .locator("[name=environment]")
    .selectOption({ label: "e2e (e2e, online)" });

  await form.locator("[name=kind]").selectOption("folder");
  await form.locator("[name=location]").fill(root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();
  const id = new URL(page.url()).hash.slice(1);
  const item = page.locator(`#sessions li[data-id="${id}"]`);

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

  await form
    .locator("[name=environment]")
    .selectOption({ label: "e2e (e2e, online)" });

  await form.locator("[name=kind]").selectOption("folder");
  await form.locator("[name=location]").fill(root);
  await form.getByRole("button", { name: "Start session" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();

  await page.locator("#prompt-text").fill("pick a size");
  await page.locator("#prompt-text").press("Enter");

  const card = page.locator('[data-role="prompt"]');
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

  await form
    .locator("[name=environment]")
    .selectOption({ label: "e2e (e2e, online)" });

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
  await form.locator("[name=name]").fill("Site");
  await form.locator("[name=repositories]").fill(repository);
  await form.getByRole("button", { name: "New Project" }).click();
  await page.getByRole("heading", { name: "Site" }).waitFor();
  await page.getByText("No threads yet.").waitFor();

  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("start_thread", { title: "Docs", message: "write docs" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("ok")]),
    fauxAssistantMessage([fauxText("ok")]),
  ]);

  await page.getByRole("button", { name: "Open coordinator" }).click();
  await page.locator("#status", { hasText: "idle" }).waitFor();
  await page.locator("#prompt-text").fill("start a docs thread");
  await page.locator("#prompt-text").press("Enter");

  await page
    .locator('#chat li[data-role="assistant"]', { hasText: "ok" })
    .waitFor();

  await page
    .locator("#plugin-nav")
    .getByRole("link", { name: "Projects" })
    .click();

  await page.getByRole("button", { name: /^Site/ }).click();

  const row = page.locator("tr", { hasText: "Docs" });
  await row.locator("td", { hasText: /^e2e$/ }).waitFor();

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
