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

// Real `git diff --binary` output for names git quotes or pads.
const awkward = [
  "diff --git a/bin.dat b/bin.dat",
  "index 8352675d67aed6625ece79af41c27fdb4ee2e867..41ef245bf5bf366a559ba1bd27cd14683e3d0692 100644",
  "GIT binary patch",
  "literal 3",
  "KcmZQzW&!{J3jhWH",
  "",
  "literal 3",
  "KcmZQzWC8#H2LJ>B",
  "",
  "diff --git a/mode.sh b/mode.sh",
  "old mode 100644",
  "new mode 100755",
  'diff --git "a/na\\303\\257ve.txt" "b/na\\303\\257ve.txt"',
  "index 5626abf..f719efd 100644",
  '--- "a/na\\303\\257ve.txt"',
  '+++ "b/na\\303\\257ve.txt"',
  "@@ -1 +1 @@",
  "-one",
  "+two",
  "diff --git a/old.txt b/new.txt",
  "similarity index 100%",
  "rename from old.txt",
  "rename to new.txt",
  'diff --git "a/ta\\tb.txt" "b/ta\\tb.txt"',
  "new file mode 100644",
  "index 0000000..8cc35a3",
  "--- /dev/null",
  '+++ "b/ta\\tb.txt"',
  "@@ -0,0 +1 @@",
  "+tab",
  "diff --git a/with space.txt b/with space.txt",
  "index 587be6b..ccc9bd6 100644",
  "--- a/with space.txt\t",
  "+++ b/with space.txt\t",
  "@@ -1 +1 @@",
  "-x",
  "+xx",
  "diff --git a/x b/y.txt b/x b/y.txt",
  "index b680253..d7f758c 100644",
  "--- a/x b/y.txt\t",
  "+++ b/x b/y.txt\t",
  "@@ -1 +1 @@",
  "-z",
  "+zz",
  "",
].join("\n");

test("reads quoted, spaced and binary paths the way git writes them", () => {
  expect(parseDiff(awkward).map(({ path }) => path)).toEqual([
    "bin.dat",
    "mode.sh",
    "naïve.txt",
    "new.txt",
    "ta\tb.txt",
    "with space.txt",
    "x b/y.txt",
  ]);
});

test("describes changes that have no lines to show", () => {
  expect(parseDiff(awkward).map(({ notes }) => notes)).toEqual([
    ["Binary file changed"],
    ["Mode changed from 100644 to 100755"],
    [],
    ["Renamed from old.txt"],
    [],
    [],
    [],
  ]);

  expect(
    parseDiff(
      [
        "diff --git a/empty b/empty",
        "new file mode 100644",
        "index 0000000..e69de29",
        "",
      ].join("\n"),
    )[0]?.notes,
  ).toEqual(["Empty file added"]);
});

test("an empty patch has no files", () => {
  expect(parseDiff("")).toEqual([]);
});
