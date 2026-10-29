import { json, ok, useLoaded } from "@pipoca/plugins/web";
import { profilePath } from "@pipoca/protocol";
import { Button, cn, Field, FileButton, fieldClass, Section } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { api, send } from "./api";

const errors: Readonly<Record<string, string>> = {
  default: "Make another Profile the default before deleting this one.",
  in_use: "Sessions still use this Profile. Archive them first.",
  admin_only: "Only admins change shared Profiles.",
};

export function messageOf(reason: unknown): string {
  const code = reason instanceof Error ? reason.message : String(reason);

  return errors[code] ?? code;
}

interface ProfileFile {
  readonly path: string;
  readonly size: number;
}

// One kind of thing Pi loads from an agent folder, such as skills, found by
// where its files sit.
export interface Kind {
  readonly title: string;
  readonly about: string;
  // The name to list a file under, or undefined for files of other kinds
  // and a skill's own supporting files.
  readonly nameOf: (path: string) => string | undefined;
  readonly newPath: (name: string) => string;
  readonly template: (name: string) => string;
  readonly placeholder: string;
  // Uploads land in this folder, and a picked folder keeps its own name.
  // Without one, uploads land at the top and a picked folder, such as
  // ~/.pi/agent, leaves its name out.
  readonly folder?: string;
}

function sizeText(bytes: number): string {
  return bytes < 1024
    ? `${String(bytes)} B`
    : `${(bytes / 1024).toFixed(1)} KB`;
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }

  return btoa(text);
}

// What machines keep for themselves, such as auth.json, is never sent
// (ADR 0041).
export async function upload(
  url: string,
  picked: readonly File[],
  { folder, picked: pickedFolder }: { folder?: string; picked: boolean },
): Promise<void> {
  const files: Record<string, string> = {};

  for (const file of picked) {
    const relative = pickedFolder
      ? file.webkitRelativePath
          .split("/")
          .slice(folder === undefined ? 1 : 0)
          .join("/")
      : file.name;

    const path = `${folder ?? ""}${relative}`;

    if (profilePath(path)) {
      files[path] = base64(new Uint8Array(await file.arrayBuffer()));
    }
  }

  await api(url, { files });
}

function useRun(
  reload: () => void,
): readonly [string | undefined, (action: () => Promise<void>) => void] {
  const [error, setError] = useState<string>();

  const run = (action: () => Promise<void>): void => {
    action().then(
      () => {
        setError(undefined);
        reload();
      },
      (reason: unknown) => {
        setError(messageOf(reason));
      },
    );
  };

  return [error, run];
}

// The files of one kind in a Profile's folder, each opened in a text editor.
export function KindFiles({
  url,
  kind,
}: {
  readonly url: string;
  readonly kind: Kind;
}): ReactElement {
  const { value: files = [], reload } = useLoaded(
    async () => json<ProfileFile[]>(fetch(url)),
    url,
    { topics: ["profiles"] },
  );

  const [open, setOpen] = useState<{ path: string; text: string }>();
  const [error, run] = useRun(reload);

  const fileUrl = (path: string): string =>
    `${url}/${encodeURIComponent(path)}`;

  const listed = files.flatMap((file) => {
    const name = kind.nameOf(file.path);

    return name === undefined ? [] : [{ ...file, name }];
  });

  const picker = (pickedFolder: boolean): ReactElement => (
    <FileButton
      multiple
      {...(pickedFolder && { webkitdirectory: "" })}
      onFiles={(picked) => {
        run(async () => {
          await upload(url, picked, {
            ...(kind.folder !== undefined && { folder: kind.folder }),
            picked: pickedFolder,
          });
        });
      }}
    >
      {pickedFolder ? "Upload a folder" : "Upload files"}
    </FileButton>
  );

  return (
    <Section title={kind.title}>
      <div className="flex flex-col gap-4 rounded-lg border border-line bg-elevated shadow-xs p-5">
        <p className="text-caption text-fg-dim">{kind.about}</p>
        <ul className="flex flex-col divide-y divide-line">
          {listed.map(({ path, size, name }) => (
            <li key={path} className="flex items-center gap-3 py-1.5">
              <button
                type="button"
                onClick={() => {
                  run(async () => {
                    const text = await (await ok(fetch(fileUrl(path)))).text();
                    setOpen({ path, text });
                  });
                }}
                className="flex min-w-0 flex-1 items-baseline gap-3 text-left text-fg hover:text-accent"
              >
                <span className="truncate font-mono text-mono-sm">{name}</span>
                {name !== path && (
                  <span className="truncate font-mono text-caption text-fg-dim">
                    {path}
                  </span>
                )}
              </button>
              <span className="text-caption text-fg-dim">{sizeText(size)}</span>
            </li>
          ))}
          {listed.length === 0 && (
            <li className="py-1.5 text-caption text-fg-dim">None yet.</li>
          )}
        </ul>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const name = new FormData(event.currentTarget).get("name");
            if (typeof name === "string" && name.trim() !== "") {
              setOpen({
                path: kind.newPath(name.trim()),
                text: kind.template(name.trim()),
              });

              event.currentTarget.reset();
            }
          }}
          className="flex flex-wrap gap-2"
        >
          <input
            name="name"
            aria-label={`New in ${kind.title}`}
            placeholder={kind.placeholder}
            className={cn(fieldClass, "min-w-48 flex-1 font-mono")}
          />
          <Button type="submit">New</Button>
          {picker(false)}
          {picker(true)}
        </form>
        {open && (
          <FileEditor
            key={open.path}
            file={open}
            onSave={(text) => {
              run(async () => {
                await ok(
                  fetch(fileUrl(open.path), { method: "PUT", body: text }),
                );
              });
            }}
            onDelete={() => {
              run(async () => {
                await send(fileUrl(open.path), "DELETE");
                setOpen(undefined);
              });
            }}
            onClose={() => {
              setOpen(undefined);
            }}
          />
        )}
        <p role="alert" className="text-caption text-failed">
          {error}
        </p>
      </div>
    </Section>
  );
}

function FileEditor({
  file,
  onSave,
  onDelete,
  onClose,
}: {
  readonly file: { readonly path: string; readonly text: string };
  readonly onSave: (text: string) => void;
  readonly onDelete: () => void;
  readonly onClose: () => void;
}): ReactElement {
  const [text, setText] = useState(file.text);

  return (
    <div className="flex flex-col gap-2">
      <Field label={file.path}>
        <textarea
          value={text}
          rows={12}
          onChange={(event) => {
            setText(event.target.value);
          }}
          className={cn(fieldClass, "min-h-48 resize-y font-mono text-mono-sm")}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          onClick={() => {
            onSave(text);
          }}
        >
          Save file
        </Button>
        <Button onClick={onClose}>Close</Button>
        <Button
          variant="danger"
          onClick={() => {
            if (confirm(`Delete ${file.path}?`)) {
              onDelete();
            }
          }}
        >
          Delete file
        </Button>
      </div>
    </div>
  );
}

export interface OneFile {
  readonly path: string;
  readonly about: string;
  readonly example: string;
}

// Files Pi reads by a fixed name, such as mcp.json. Saving one empty deletes
// it.
export function NamedFiles({
  url,
  title,
  files,
}: {
  readonly url: string;
  readonly title: string;
  readonly files: readonly OneFile[];
}): ReactElement {
  const { value: texts, reload } = useLoaded(
    async () =>
      Promise.all(
        files.map(async ({ path }) => {
          const response = await fetch(`${url}/${encodeURIComponent(path)}`);

          return response.ok ? response.text() : "";
        }),
      ),
    `${url}:${files.map(({ path }) => path).join()}`,
    { topics: ["profiles"] },
  );

  return (
    <Section title={title}>
      <div className="flex flex-col gap-6 rounded-lg border border-line bg-elevated shadow-xs p-5">
        {texts &&
          files.map((file, n) => (
            <NamedFile
              key={`${file.path}:${texts[n] ?? ""}`}
              url={`${url}/${encodeURIComponent(file.path)}`}
              file={file}
              text={texts[n] ?? ""}
              onSaved={reload}
            />
          ))}
      </div>
    </Section>
  );
}

function NamedFile({
  url,
  file,
  text: saved,
  onSaved,
}: {
  readonly url: string;
  readonly file: OneFile;
  readonly text: string;
  readonly onSaved: () => void;
}): ReactElement {
  const [text, setText] = useState(saved);
  const [error, run] = useRun(onSaved);

  const save = async (): Promise<void> => {
    if (text.trim() === "") {
      if (saved !== "") {
        await send(url, "DELETE");
      }

      return;
    }

    if (file.path.endsWith(".json")) {
      try {
        JSON.parse(text);
      } catch {
        throw new Error(`${file.path} isn't valid JSON.`);
      }
    }

    await ok(fetch(url, { method: "PUT", body: text }));
  };

  return (
    <div className="flex flex-col gap-2">
      <Field label={file.path}>
        <textarea
          value={text}
          rows={8}
          placeholder={file.example}
          onChange={(event) => {
            setText(event.target.value);
          }}
          className={cn(fieldClass, "min-h-32 resize-y font-mono text-mono-sm")}
        />
      </Field>
      <p className="text-caption text-fg-dim">{file.about}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={text === saved}
          onClick={() => {
            run(save);
          }}
        >
          Save
        </Button>
        <p role="alert" className="text-caption text-failed">
          {error}
        </p>
      </div>
    </div>
  );
}
