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

  // Sign-in, change events, Sessions and MCP have rules of their own.
  const own = ["auth", "changes", "sessions", "mcp"];

  expect(
    served.filter(
      (name) => !own.includes(name ?? "") && !listed.includes(name ?? ""),
    ),
  ).toEqual([]);
});

// Kyma's gateway ends a request after 180 seconds unless its rule says
// otherwise, which would cut change feeds, Session event streams, terminals
// and MCP streams. 3900 seconds is the most an APIRule allows.
test("the APIRule keeps streams and terminals open as long as Kyma allows", () => {
  const rules = new Map(
    apiRule
      .split("\n    - path: ")
      .slice(1)
      .map((rule) => [rule.split("\n")[0], rule]),
  );

  const streaming = [
    "/api/changes",
    "/api/sessions/{**}",
    "/api/mcp",
    "/agent/{**}",
  ];

  expect(
    streaming.map(
      (path) => /^ {6}timeout: (\d+)$/m.exec(rules.get(path) ?? "")?.[1],
    ),
  ).toEqual(["3900", "3900", "3900", "3900"]);
});

// Plugin routes remove things with DELETE, so the gateway has to let it
// through to them.
test("the APIRule lets plugin routes take DELETE", () => {
  const methods = /\{\{- \$methods := list ((?:"[A-Z]+" ?)+)\}\}/
    .exec(apiRule)?.[1]
    ?.split(" ")
    .map((method) => method.replaceAll('"', ""));

  const plugins = /range list ((?:"[a-z-]+" ?)+)/.exec(apiRule)?.[1];

  expect([methods?.includes("DELETE"), plugins?.includes('"plugins"')]).toEqual(
    [true, true],
  );
});
