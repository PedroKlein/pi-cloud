import { expect, test } from "bun:test";
import { parseDiff } from "./diff";

const patch = [
  "diff --git a/notes.txt b/notes.txt",
  "index 1111111..2222222 100644",
  "--- a/notes.txt",
  "+++ b/notes.txt",
  "@@ -1,3 +1,3 @@ heading",
  " keep",
  "-old",
  "+new",
  " tail",
  "\\ No newline at end of file",
  "diff --git a/gone.md b/gone.md",
  "deleted file mode 100644",
  "--- a/gone.md",
  "+++ /dev/null",
  "@@ -10 +0,0 @@",
  "-bye",
  "",
].join("\n");

test("splits a patch into files with counts and line numbers", () => {
  const [notes, gone] = parseDiff(patch);

  expect(notes?.path).toBe("notes.txt");
  expect([notes?.added, notes?.removed]).toEqual([1, 1]);

  expect(
    notes?.hunks[0]?.lines.map(({ kind, oldLine, newLine }) => [
      kind,
      oldLine,
      newLine,
    ]),
  ).toEqual([
    ["context", 1, 1],
    ["remove", 2, undefined],
    ["add", undefined, 2],
    ["context", 3, 3],
    ["note", undefined, undefined],
  ]);

  expect(gone?.path).toBe("gone.md");

  expect(gone?.hunks[0]?.lines).toEqual([
    { kind: "remove", text: "bye", oldLine: 10, newLine: undefined },
  ]);
});

test("an empty patch has no files", () => {
  expect(parseDiff("")).toEqual([]);
});
