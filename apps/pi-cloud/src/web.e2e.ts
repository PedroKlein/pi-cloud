import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
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

  const form = page.locator("form#create");
  await form.locator("[name=provider]").fill("e2e");
  await form.locator("[name=kind]").selectOption("folder");
  await form.locator("[name=location]").fill(root);
  await form.getByRole("button", { name: "New session" }).click();
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

  const form = page.locator("form#create");
  await form.locator("[name=provider]").fill("e2e");
  await form.locator("[name=kind]").selectOption("folder");
  await form.locator("[name=location]").fill(root);
  await form.getByRole("button", { name: "New session" }).click();
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
