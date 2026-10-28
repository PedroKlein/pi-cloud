import { expect, test } from "bun:test";
import { ghConfig } from "./credentials";

test("gives gh the hosts other than github.com, which it reads from GH_TOKEN", () => {
  expect(
    ghConfig([
      { host: "github.com", token: "own-token" },
      { host: "github.tools.sap", token: "sap-token" },
    ]),
  ).toEqual({
    "config.yml": 'version: "1"\n',
    "hosts.yml":
      '"github.tools.sap":\n  oauth_token: "sap-token"\n  git_protocol: https\n',
  });

  expect(
    ghConfig([{ host: "github.com", token: "own-token" }]),
  ).toBeUndefined();
});
