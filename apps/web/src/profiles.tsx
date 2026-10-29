import { json, ok, useLoaded } from "@pipoca/plugins/web";
import {
  type PiPackage,
  type Profile,
  type ProfileContent,
  profilePath,
} from "@pipoca/protocol";
import {
  Badge,
  Button,
  cn,
  Field,
  FileButton,
  fieldClass,
  Icon,
  ListInput,
  PageTitle,
  Section,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { api, send } from "./api";

const errors: Readonly<Record<string, string>> = {
  default: "Make another Profile the default before deleting this one.",
  in_use: "Sessions still use this Profile. Archive them first.",
  admin_only: "Only admins change shared Profiles.",
};

interface ProfileFile {
  readonly path: string;
  readonly size: number;
}

// A package is a source such as npm:name, or a JSON object with Pi's
// filters.
function packageText(pkg: PiPackage): string {
  return typeof pkg === "string" ? pkg : JSON.stringify(pkg);
}

function packageOf(text: string): unknown {
  return text.startsWith("{") ? JSON.parse(text) : text;
}

function messageOf(reason: unknown): string {
  const code = reason instanceof Error ? reason.message : String(reason);

  return errors[code] ?? code;
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

// Files picked one by one keep their names. A picked folder, such as
// ~/.pi/agent, leaves its own name out, and what machines keep for
// themselves, such as auth.json, is never sent (ADR 0041).
async function upload(
  url: string,
  picked: readonly File[],
  folder: boolean,
): Promise<void> {
  const files: Record<string, string> = {};

  for (const file of picked) {
    const path = folder
      ? file.webkitRelativePath.split("/").slice(1).join("/")
      : file.name;

    if (profilePath(path)) {
      files[path] = base64(new Uint8Array(await file.arrayBuffer()));
    }
  }

  await api(url, { files });
}

// Not a Profile id, so no Profile's page can take it.
const baseHash = ":base";

export function ProfilesPage({
  profiles,
  selected,
  onChange,
}: {
  readonly profiles: readonly Profile[];
  readonly selected: string;
  readonly onChange: () => void;
}): ReactElement {
  const profile = profiles.find(({ id }) => id === selected);
  // The editor starts again when its files change, so it doesn't keep this.
  const [savedId, setSavedId] = useState<string>();

  return (
    <div
      id="profiles-page"
      className="mx-auto flex w-full max-w-form flex-col px-4 py-10 md:px-10"
    >
      <PageTitle description="A Profile is a Pi agent folder, like your ~/.pi/agent: packages, instructions, skills, prompts, MCP servers and settings. Every Session runs with one, on any machine. Logins stay on each machine. Edits reach a Session the next time it starts.">
        Profiles
      </PageTitle>
      <div className="flex flex-wrap gap-2">
        {profiles.map((each) => (
          <a
            key={each.id}
            href={`#profiles/${each.id}`}
            aria-current={each.id === selected ? "page" : undefined}
            className="flex items-center gap-2 rounded-md border border-line bg-panel px-3 py-1.5 text-ui text-fg hover:bg-hover aria-[current=page]:border-accent aria-[current=page]:text-fg-strong"
          >
            {each.name}
            {each.isDefault && <Badge state="done">Default</Badge>}
            {each.ownerId === null && <Badge state="offline">Shared</Badge>}
          </a>
        ))}
        <a
          href={`#profiles/${baseHash}`}
          aria-current={selected === baseHash ? "page" : undefined}
          className="flex items-center gap-2 rounded-md border border-line bg-panel px-3 py-1.5 text-ui text-fg hover:bg-hover aria-[current=page]:border-accent aria-[current=page]:text-fg-strong"
        >
          Base
          <Badge state="offline">Under every Profile</Badge>
        </a>
        <a
          href="#profiles/new"
          aria-current={selected === "new" ? "page" : undefined}
          className="flex items-center gap-1 rounded-md border border-dashed border-line px-3 py-1.5 text-ui text-fg-dim hover:bg-hover aria-[current=page]:border-accent"
        >
          <Icon name="plus" className="size-4" />
          New Profile
        </a>
      </div>
      {profile && (
        <>
          <Editor
            key={`${profile.id}:${profile.agentsMd}:${JSON.stringify(profile.packages)}`}
            profile={profile}
            saved={savedId === profile.id}
            onSaved={() => {
              setSavedId(profile.id);
            }}
            onChange={onChange}
          />
          <Files
            key={`${profile.id}-files`}
            url={`/api/profiles/${profile.id}/files`}
          />
        </>
      )}
      {selected === baseHash && <BaseEditor />}
      {selected === baseHash && <Files url="/api/base/files" />}
      {selected === "new" && <Editor key="new" onChange={onChange} />}
      {selected === "" && <Import onChange={onChange} />}
    </div>
  );
}

function Editor({
  profile,
  saved = false,
  onSaved,
  onChange,
}: {
  readonly profile?: Profile;
  readonly saved?: boolean;
  readonly onSaved?: () => void;
  readonly onChange: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();

  const [packages, setPackages] = useState<readonly string[]>(() =>
    (profile?.packages ?? []).map(packageText),
  );

  const run = (action: () => Promise<void>): void => {
    action().then(
      () => {
        setError(undefined);
        onChange();
      },
      (reason: unknown) => {
        setError(messageOf(reason));
      },
    );
  };

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const text = (name: string): string => {
      const value = form.get(name);

      return typeof value === "string" ? value : "";
    };

    run(async () => {
      const body = {
        name: text("name"),
        packages: packages.map(packageOf),
        agentsMd: text("agentsMd"),
      };

      if (profile) {
        // Only what changed here, so a file edited below or by hand since
        // isn't written back as it was.
        const changed = Object.fromEntries(
          Object.entries(body).filter(
            ([key, value]) =>
              JSON.stringify(value) !==
              JSON.stringify(profile[key as keyof typeof body]),
          ),
        );

        await send(`/api/profiles/${profile.id}`, "PUT", changed);
        onSaved?.();

        return;
      }

      const created = (await (
        await api("/api/profiles", {
          ...body,
          shared: form.get("shared") === "on",
        })
      ).json()) as Profile;

      location.hash = `profiles/${created.id}`;
    });
  };

  return (
    <Section title={profile ? profile.name : "New Profile"}>
      <form
        onSubmit={submit}
        className="flex flex-col gap-4 rounded-lg border border-line bg-elevated shadow-xs p-5"
      >
        <Field label="Name">
          <input
            name="name"
            required
            defaultValue={profile?.name ?? ""}
            className={fieldClass}
          />
        </Field>
        {!profile && (
          <label className="flex items-center gap-2 text-ui text-fg">
            <input type="checkbox" name="shared" />
            Shared with everyone. Only admins can change it.
          </label>
        )}
        <ListInput
          label="Pi packages"
          values={packages}
          placeholder="npm:pi-subagents, git:… or a path, then Enter"
          onChange={setPackages}
        />
        <Field label="AGENTS.md">
          <textarea
            name="agentsMd"
            rows={5}
            defaultValue={profile?.agentsMd ?? ""}
            className={cn(
              fieldClass,
              "min-h-24 resize-y font-mono text-mono-sm",
            )}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" type="submit">
            {profile ? "Save" : "Create Profile"}
          </Button>
          {profile && !profile.isDefault && (
            <Button
              onClick={() => {
                run(async () => {
                  await api(`/api/profiles/${profile.id}/default`, {});
                });
              }}
            >
              Make default
            </Button>
          )}
          {profile && (
            <a
              href={`/api/profiles/${profile.id}/export`}
              download
              className="inline-flex h-control items-center rounded-md px-3 text-ui font-medium text-fg-dim hover:bg-hover hover:text-fg"
            >
              Export
            </a>
          )}
          {profile && !profile.isDefault && (
            <Button
              variant="danger"
              onClick={() => {
                if (!confirm(`Delete the Profile "${profile.name}"?`)) {
                  return;
                }

                run(async () => {
                  await send(`/api/profiles/${profile.id}`, "DELETE");
                  location.hash = "profiles";
                });
              }}
            >
              Delete
            </Button>
          )}
          <p role="status" className="text-caption">
            {error !== undefined ? (
              <span className="text-failed">{error}</span>
            ) : (
              saved && <span className="text-fg-dim">Saved</span>
            )}
          </p>
        </div>
      </form>
    </Section>
  );
}

// The base Profile's packages and AGENTS.md, which every Session loads under
// its own Profile's (ADR 0044).
function BaseEditor(): ReactElement | null {
  const { value: base, reload } = useLoaded(
    async () => json<ProfileContent>(fetch("/api/base")),
    "base",
    { topics: ["profiles"] },
  );

  // The form starts again when the base changes, so it doesn't keep this.
  const [saved, setSaved] = useState(false);

  return base ? (
    <BaseForm
      key={`${base.agentsMd}:${JSON.stringify(base.packages)}`}
      base={base}
      saved={saved}
      onSaved={() => {
        setSaved(true);
        reload();
      }}
    />
  ) : null;
}

function BaseForm({
  base,
  saved,
  onSaved,
}: {
  readonly base: ProfileContent;
  readonly saved: boolean;
  readonly onSaved: () => void;
}): ReactElement {
  const [packages, setPackages] = useState<readonly string[]>(() =>
    base.packages.map(packageText),
  );

  const [agentsMd, setAgentsMd] = useState(base.agentsMd);
  const [error, setError] = useState<string>();

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();

    send("/api/base", "PUT", {
      packages: packages.map(packageOf),
      agentsMd,
    }).then(
      () => {
        setError(undefined);
        onSaved();
      },
      (reason: unknown) => {
        setError(messageOf(reason));
      },
    );
  };

  return (
    <Section title="Base">
      <form
        onSubmit={submit}
        className="flex flex-col gap-4 rounded-lg border border-line bg-elevated shadow-xs p-5"
      >
        <p className="text-caption text-fg-dim">
          Every Session loads this under its own Profile, with the
          Profile&apos;s entries winning. Put provider extensions here so every
          Session can use their models. Only admins change it.
        </p>
        <ListInput
          label="Pi packages"
          values={packages}
          placeholder="npm:pi-subagents, git:… or a path, then Enter"
          onChange={setPackages}
        />
        <Field label="AGENTS.md">
          <textarea
            value={agentsMd}
            rows={5}
            onChange={(event) => {
              setAgentsMd(event.target.value);
            }}
            className={cn(
              fieldClass,
              "min-h-24 resize-y font-mono text-mono-sm",
            )}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" type="submit">
            Save
          </Button>
          <p role="status" className="text-caption">
            {error !== undefined ? (
              <span className="text-failed">{error}</span>
            ) : (
              saved && <span className="text-fg-dim">Saved</span>
            )}
          </p>
        </div>
      </form>
    </Section>
  );
}

// Every file in a Profile's folder, as Pi reads them from ~/.pi/agent.
function Files({ url }: { readonly url: string }): ReactElement {
  const { value: files = [], reload } = useLoaded(
    async () => json<ProfileFile[]>(fetch(url)),
    url,
    { topics: ["profiles"] },
  );

  const [open, setOpen] = useState<{ path: string; text: string }>();
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

  const fileUrl = (path: string): string =>
    `${url}/${encodeURIComponent(path)}`;

  const show = (path: string): void => {
    run(async () => {
      const text = await (await ok(fetch(fileUrl(path)))).text();
      setOpen({ path, text });
    });
  };

  const picker = (folder: boolean): ReactElement => (
    <FileButton
      multiple
      {...(folder && { webkitdirectory: "" })}
      onFiles={(picked) => {
        run(async () => upload(url, picked, folder));
      }}
    >
      {folder ? "Upload a folder" : "Upload files"}
    </FileButton>
  );

  return (
    <Section title="Files">
      <div className="flex flex-col gap-4 rounded-lg border border-line bg-elevated shadow-xs p-5">
        <ul className="flex flex-col divide-y divide-line">
          {files.map(({ path, size }) => (
            <li key={path} className="flex items-center gap-3 py-1.5">
              <button
                type="button"
                onClick={() => {
                  show(path);
                }}
                className="flex-1 truncate text-left font-mono text-mono-sm text-fg hover:text-accent"
              >
                {path}
              </button>
              <span className="text-caption text-fg-dim">{sizeText(size)}</span>
            </li>
          ))}
          {files.length === 0 && (
            <li className="py-1.5 text-caption text-fg-dim">
              No files yet, so this is plain Pi.
            </li>
          )}
        </ul>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const path = new FormData(event.currentTarget).get("path");
            if (typeof path === "string" && path.trim() !== "") {
              setOpen({ path: path.trim(), text: "" });
              event.currentTarget.reset();
            }
          }}
          className="flex flex-wrap gap-2"
        >
          <input
            name="path"
            placeholder="skills/review/SKILL.md"
            className={cn(fieldClass, "min-w-48 flex-1 font-mono")}
          />
          <Button type="submit">New file</Button>
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

function Import({ onChange }: { readonly onChange: () => void }): ReactElement {
  const [error, setError] = useState<string>();

  const imported = (action: () => Promise<Profile>): void => {
    action().then(
      (profile) => {
        setError(undefined);
        onChange();
        location.hash = `profiles/${profile.id}`;
      },
      (reason: unknown) => {
        setError(messageOf(reason));
      },
    );
  };

  const fromFile = async (file: File): Promise<Profile> => {
    if (file.name.endsWith(".json")) {
      return json<Profile>(
        api("/api/profiles/import", JSON.parse(await file.text())),
      );
    }

    const name = file.name.replace(/\.(tar\.gz|tgz)$/, "");

    return json<Profile>(
      fetch(`/api/profiles/import?name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": "application/gzip" },
        body: file,
      }),
    );
  };

  const fromFolder = async (picked: readonly File[]): Promise<Profile> => {
    const name = picked[0]?.webkitRelativePath.split("/")[0] ?? "Imported";
    const profile = await json<Profile>(api("/api/profiles", { name }));
    await upload(profile.id, picked, true);

    return profile;
  };

  return (
    <Section title="Import a Profile">
      <div className="flex flex-col gap-4 rounded-lg border border-line bg-elevated shadow-xs p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-label font-medium text-fg">
              From a folder
            </span>
            <span className="text-caption text-fg-dim">
              Such as your ~/.pi/agent. Logins and Session history stay behind.
            </span>
          </div>
          <FileButton
            multiple
            {...{ webkitdirectory: "" }}
            onFiles={(picked) => {
              imported(async () => fromFolder(picked));
            }}
          >
            Choose a folder
          </FileButton>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-label font-medium text-fg">
            From an exported .tar.gz
          </span>
          <FileButton
            accept=".gz,.tgz,.json,application/gzip,application/json"
            onFiles={([file]) => {
              if (file) {
                imported(async () => fromFile(file));
              }
            }}
          >
            Choose a file
          </FileButton>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const url = new FormData(event.currentTarget).get("url");

            imported(async () =>
              json<Profile>(
                api("/api/profiles/import", {
                  url: typeof url === "string" ? url.trim() : "",
                }),
              ),
            );
          }}
          className="flex flex-col gap-1.5"
        >
          <Field label="From a git repository that holds a Profile folder">
            <span className="flex gap-2">
              <input
                name="url"
                required
                placeholder="https://github.com/me/pi-setup.git"
                className={cn(fieldClass, "flex-1")}
              />
              <Button type="submit">Import</Button>
            </span>
          </Field>
        </form>
        <p role="alert" className="text-caption text-failed">
          {error}
        </p>
      </div>
    </Section>
  );
}
