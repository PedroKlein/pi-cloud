import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// A runner that never ran the Session starts it from the server's copy of
// its transcript (ADR 0032). Pi finds a Session's file by the folder in its
// header, and this runner may keep the Workspace elsewhere.
export async function restoreTranscript(
  sessionDir: string,
  cwd: string,
  entries: () => Promise<readonly string[]>,
): Promise<number> {
  const local = await readdir(sessionDir).catch(() => []);
  if (local.some((file) => file.endsWith(".jsonl"))) {
    return 0;
  }

  const [header, ...rest] = await entries();
  if (header === undefined) {
    return 0;
  }

  const parsed = JSON.parse(header) as { type?: string; id?: string };

  const moved =
    parsed.type === "session" ? JSON.stringify({ ...parsed, cwd }) : header;

  await mkdir(sessionDir, { recursive: true });

  await writeFile(
    join(sessionDir, `restored_${parsed.id ?? "session"}.jsonl`),
    `${[moved, ...rest].join("\n")}\n`,
  );

  return rest.length + 1;
}
