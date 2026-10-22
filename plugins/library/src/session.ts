import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { SessionCloud, SessionPlugin } from "@pi-cloud/plugins";
import {
  fileLimit,
  type LibraryFile,
  nameRule,
  sizeRule,
  validName,
} from "./model";

// Only Sessions in a Project get the library tools.
export const library: SessionPlugin = {
  name: "library",
  tools: async (cloud) =>
    (await cloud.request("member")).ok ? libraryTools(cloud) : [],
};

function libraryTools({ request }: SessionCloud): ToolDefinition[] {
  const ok = async (response: Response): Promise<Response> => {
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };

      throw new Error(
        body.error ?? `library answered ${String(response.status)}`,
      );
    }

    return response;
  };

  const libraryPath = (name: string): string => {
    const composed = name.normalize("NFC");
    if (!validName(composed)) {
      throw new Error(nameRule);
    }

    return `files/${encodeURIComponent(composed)}`;
  };

  const text = (
    said: string,
  ): { content: { type: "text"; text: string }[]; details: undefined } => ({
    content: [{ type: "text", text: said }],
    details: undefined,
  });

  return [
    defineTool({
      name: "list_library",
      label: "List library",
      description:
        "List the files in the Project's shared library, with size, last writer and time.",
      parameters: Type.Object({}),
      async execute() {
        const files = (await (
          await ok(await request("files"))
        ).json()) as LibraryFile[];

        return text(
          files.length === 0
            ? "The library is empty."
            : files
                .map(
                  (file) =>
                    `${file.name} · ${String(file.size)} bytes · ${file.actor} · ${file.updatedAt}`,
                )
                .join("\n"),
        );
      },
    }),
    defineTool({
      name: "publish_file",
      label: "Publish file",
      description:
        "Copy a file from your working directory into the Project's shared library, where the user and every Project session can get it. It replaces a library file of the same name.",
      parameters: Type.Object({
        path: Type.String({
          description: "The file's path, relative to your working directory",
        }),
        name: Type.Optional(
          Type.String({
            description: "Its name in the library. Default: the file's name",
          }),
        ),
      }),
      async execute(_id, params, signal, _update, ctx) {
        const path = resolve(ctx.cwd, params.path);
        const name = params.name ?? basename(path);

        if ((await stat(path)).size > fileLimit) {
          throw new Error(sizeRule);
        }

        const content = await readFile(path);

        await ok(
          await request(libraryPath(name), {
            method: "PUT",
            body: content,
            ...(signal && { signal }),
          }),
        );

        return text(
          `Published ${params.path} as ${name} (${String(content.length)} bytes).`,
        );
      },
    }),
    defineTool({
      name: "fetch_file",
      label: "Fetch file",
      description:
        "Copy a file from the Project's shared library into your working directory.",
      parameters: Type.Object({
        name: Type.String({ description: "The library file's name" }),
        path: Type.Optional(
          Type.String({
            description:
              "Where to write it, relative to your working directory. Default: its name",
          }),
        ),
      }),
      async execute(_id, params, signal, _update, ctx) {
        const response = await ok(
          await request(libraryPath(params.name), {
            ...(signal && { signal }),
          }),
        );

        const path = resolve(ctx.cwd, params.path ?? params.name);
        const content = new Uint8Array(await response.arrayBuffer());
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);

        return text(
          `Wrote ${params.name} to ${path} (${String(content.length)} bytes).`,
        );
      },
    }),
  ];
}
