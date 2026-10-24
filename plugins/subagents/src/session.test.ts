import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionCloud } from "@pi-cloud/plugins";
import { subagents } from "./session";

const variable = "PI_SUBAGENT_PI_BINARY";
const before = process.env[variable];

afterEach(() => {
  if (before === undefined) {
    delete process.env["PI_SUBAGENT_PI_BINARY"];
  } else {
    process.env[variable] = before;
  }
});

function load(piCommand: string): void {
  const unused = (): never => {
    throw new Error("not used by subagents");
  };

  const cloud: SessionCloud = {
    publish: unused,
    askQuestions: unused,
    checkouts: [],
    piCommand,
    request: unused,
    log: () => undefined,
  };

  void subagents.extension?.(cloud)({} as ExtensionAPI);
}

test("points pi-subagents at the Pi the Session runs", () => {
  delete process.env["PI_SUBAGENT_PI_BINARY"];
  load("/agent/pi-cloud/bin/pi");

  expect(process.env[variable]).toBe("/agent/pi-cloud/bin/pi");
});

test("keeps a Pi the user chose for pi-subagents", () => {
  process.env[variable] = "/usr/local/bin/pi";
  load("/agent/pi-cloud/bin/pi");

  expect(process.env[variable]).toBe("/usr/local/bin/pi");
});
