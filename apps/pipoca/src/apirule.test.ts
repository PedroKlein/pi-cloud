import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const apiRule = readFileSync(
  join(import.meta.dir, "../../../deploy/helm/pipoca/templates/apirule.yaml"),
  "utf8",
);

const server = readFileSync(join(import.meta.dir, "server.ts"), "utf8");

// The gateway refuses any path its APIRule doesn't list, so a browser route
// missing from it works through a port-forward and fails on Kyma.
test("the APIRule lets the browser reach every API the server serves", () => {
  const listed =
    /range list ((?:"[a-z-]+" ?)+)/
      .exec(apiRule)?.[1]
      ?.split(" ")
      .map((name) => name.replaceAll('"', "")) ?? [];

  const served = [
    ...new Set(
      [...server.matchAll(/\^\\\/api\\\/([a-z-]+)/g)].map(([, name]) => name),
    ),
  ];

  // Sign-in, change events and MCP have rules of their own.
  const own = ["auth", "changes", "mcp"];

  expect(
    served.filter(
      (name) => !own.includes(name ?? "") && !listed.includes(name ?? ""),
    ),
  ).toEqual([]);
});
