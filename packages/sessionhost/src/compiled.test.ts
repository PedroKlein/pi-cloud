import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  const packageRoot = fileURLToPath(new URL("..", import.meta.url));

  await run(process.execPath, [
    "build",
    "--compile",
    "--root",
    packageRoot,
    entry,
    join(packageRoot, "src/extensions/codemode/worker.ts"),
    "--outfile",
    binary,
  ]);
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a compiled binary loads extensions from disk and runs codemode", async () => {
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

  await mkdir(join(root, "agent"));

  await writeFile(
    join(root, "agent", "settings.json"),
    JSON.stringify({ defaultTools: ["+codemode"] }),
  );

  const { stdout } = await run(binary, [root, subagents, local], {
    cwd: root,
  });

  const result = JSON.parse(stdout) as {
    tools: string[];
    reply: string;
    toolOutputs: string[];
  };

  expect(result.tools).toContain("subagent");
  expect(result.tools).toContain("local_tool");
  expect(result.reply).toBe("compiled ok");
  expect(result.toolOutputs.join()).toContain("Script completed");
  expect(result.toolOutputs.join()).toContain("42");
}, 30_000);
