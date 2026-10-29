import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const chart = join(import.meta.dir, "../../../deploy/helm/pipoca");
const values = readFileSync(join(chart, "values.yaml"), "utf8");

const deployment = readFileSync(
  join(chart, "templates/deployment.yaml"),
  "utf8",
);

const plugin = readFileSync(
  join(import.meta.dir, "../../../plugins/kubernetes/src/server.ts"),
  "utf8",
);

// Runner pods copy the pipoca binary from the server's image. A node that
// keeps an old pull of a moving tag hands them an old binary, which the
// server turns away once the protocol changes.
test("the chart pulls its moving image tag again, for the server and runner pods", () => {
  const image = /^image:\n((?: {2}.*\n|\s*\n)+)/m.exec(values)?.[1] ?? "";

  expect(image).toMatch(/^ {2}tag: main$/m);
  expect(image).toMatch(/^ {2}pullPolicy: Always$/m);

  expect(deployment).toContain(
    "- name: PIPOCA_IMAGE_PULL_POLICY\n              value: {{ .Values.image.pullPolicy | quote }}",
  );

  expect(plugin).toContain('process.env["PIPOCA_IMAGE_PULL_POLICY"]');
});

// Under a moving tag only the image ID the server's pod ran tells a runner
// pod's old binary from the current one.
test("the chart lets the server read its own pod, to replace runner pods with an old binary", () => {
  const rbac = readFileSync(join(chart, "templates/rbac.yaml"), "utf8");

  expect(deployment).toContain(
    "- name: POD_NAME\n              valueFrom:\n                fieldRef:\n                  fieldPath: metadata.name",
  );

  expect(plugin).toContain('process.env["POD_NAME"]');

  expect(rbac).toContain(
    'resources: ["pods", "secrets", "persistentvolumeclaims"]\n    verbs: ["get",',
  );
});
