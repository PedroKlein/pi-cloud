import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
let root: string;
let binary: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sessionhost-compiled-"));
  binary = join(root, "compiled-session");
  const entry = fileURLToPath(
    import.meta.resolve("./testdata/compiled-session.ts"),
  );
  await run(process.execPath, [
    "build",
    "--compile",
    entry,
    "--outfile",
    binary,
  ]);
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a compiled binary loads extensions from disk", async () => {
  const subagents = dirname(
    fileURLToPath(import.meta.resolve("pi-subagents/package.json")),
  );
  const local = join(root, "local-extension.ts");
  await writeFile(
    local,
    `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "local_tool",
    label: "Local tool",
    description: "A tool from an extension file on disk",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: {} }),
  });
}
`,
  );

  const { stdout } = await run(binary, [root, subagents, local], {
    cwd: root,
  });
  const result = JSON.parse(stdout) as { tools: string[]; reply: string };

  expect(result.tools).toContain("subagent");
  expect(result.tools).toContain("local_tool");
  expect(result.reply).toBe("compiled ok");
}, 30_000);
