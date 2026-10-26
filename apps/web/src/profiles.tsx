import type { PiPackage, Profile } from "@pi-cloud/protocol";
import {
  Badge,
  Button,
  cn,
  Field,
  fieldClass,
  Icon,
  ListInput,
  PageTitle,
  Section,
} from "@pi-cloud/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { api, send } from "./api";

const deleteErrors: Readonly<Record<string, string>> = {
  default: "Make another Profile the default before deleting this one.",
  in_use: "Sessions still use this Profile. Archive them first.",
};

// A package is a source such as npm:name, or a JSON object with Pi's
// filters.
function packageText(pkg: PiPackage): string {
  return typeof pkg === "string" ? pkg : JSON.stringify(pkg);
}

function packageOf(text: string): unknown {
  return text.startsWith("{") ? JSON.parse(text) : text;
}

// How many of the fields folded under Advanced hold something.
function advancedSet(profile: Profile | undefined): number {
  if (profile === undefined) {
    return 0;
  }

  return [
    profile.systemMd.trim() !== "",
    profile.appendSystemMd.trim() !== "",
    Object.keys(profile.mcpServers).length > 0,
    Object.keys(profile.settings).length > 0,
  ].filter(Boolean).length;
}

function objectText(value: Readonly<Record<string, unknown>>): string {
  return Object.keys(value).length === 0 ? "" : JSON.stringify(value, null, 2);
}

function objectOf(label: string, text: string): unknown {
  if (text.trim() === "") {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} must be JSON.`);
  }
}

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

  return (
    <div
      id="profiles-page"
      className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 md:px-10"
    >
      <PageTitle description="A Profile is your Pi setup: the packages to install, instructions, MCP servers and settings. Every Session runs with one, on any machine. Logins stay on each machine. Edits reach a Session the next time it starts.">
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
          </a>
        ))}
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
        <Editor key={profile.id} profile={profile} onChange={onChange} />
      )}
      {selected === "new" && <Editor key="new" onChange={onChange} />}
      {selected === "" && <Import onChange={onChange} />}
    </div>
  );
}

function Editor({
  profile,
  onChange,
}: {
  readonly profile?: Profile;
  readonly onChange: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  const [packages, setPackages] = useState<readonly string[]>(() =>
    (profile?.packages ?? []).map(packageText),
  );

  const run = (action: () => Promise<void>): void => {
    setSaved(false);

    action().then(
      () => {
        setError(undefined);
        onChange();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
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
        systemMd: text("systemMd"),
        appendSystemMd: text("appendSystemMd"),
        mcpServers: objectOf("MCP servers", text("mcpServers")),
        settings: objectOf("Settings", text("settings")),
      };

      if (profile) {
        await send(`/api/profiles/${profile.id}`, "PUT", body);
        setSaved(true);

        return;
      }

      const created = (await (
        await api("/api/profiles", body)
      ).json()) as Profile;

      location.hash = `profiles/${created.id}`;
    });
  };

  const area = cn(fieldClass, "min-h-24 resize-y font-mono text-mono-sm");

  return (
    <Section title={profile ? profile.name : "New Profile"}>
      <form
        onSubmit={submit}
        className="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5"
      >
        <Field label="Name">
          <input
            name="name"
            required
            defaultValue={profile?.name ?? ""}
            className={fieldClass}
          />
        </Field>
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
            className={area}
          />
        </Field>
        <details className="flex flex-col">
          <summary className="cursor-pointer text-label font-medium text-fg-dim">
            Advanced: system prompt, MCP servers and Pi settings as files
            {advancedSet(profile) > 0 &&
              ` (${String(advancedSet(profile))} set)`}
          </summary>
          <div className="mt-4 flex flex-col gap-4">
            <Field label="SYSTEM.md, which replaces Pi's system prompt">
              <textarea
                name="systemMd"
                rows={3}
                defaultValue={profile?.systemMd ?? ""}
                className={area}
              />
            </Field>
            <Field label="APPEND_SYSTEM.md, added to the system prompt">
              <textarea
                name="appendSystemMd"
                rows={3}
                defaultValue={profile?.appendSystemMd ?? ""}
                className={area}
              />
            </Field>
            <Field label="MCP servers, the mcpServers object of mcp.json">
              <textarea
                name="mcpServers"
                rows={4}
                defaultValue={objectText(profile?.mcpServers ?? {})}
                placeholder='{ "docs": { "url": "https://example.com/mcp" } }'
                className={area}
              />
            </Field>
            <Field label="Pi settings, as settings.json">
              <textarea
                name="settings"
                rows={4}
                defaultValue={objectText(profile?.settings ?? {})}
                placeholder='{ "defaultThinkingLevel": "medium" }'
                className={area}
              />
            </Field>
          </div>
        </details>
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
                  await send(`/api/profiles/${profile.id}`, "DELETE").catch(
                    (reason: unknown) => {
                      const code =
                        reason instanceof Error ? reason.message : "";

                      throw new Error(deleteErrors[code] ?? code);
                    },
                  );

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

function Import({ onChange }: { readonly onChange: () => void }): ReactElement {
  const [error, setError] = useState<string>();

  const importBody = (body: unknown): void => {
    api("/api/profiles/import", body)
      .then(async (response) => {
        setError(undefined);
        onChange();
        location.hash = `profiles/${((await response.json()) as Profile).id}`;
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };

  return (
    <Section title="Import a Profile">
      <div className="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
        <Field label="From an exported file">
          <input
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) {
                return;
              }

              void file.text().then((text) => {
                try {
                  importBody(JSON.parse(text));
                } catch {
                  setError("That file isn't JSON.");
                }
              });
            }}
            className="text-ui text-fg-dim"
          />
        </Field>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const url = new FormData(event.currentTarget).get("url");
            importBody({ url: typeof url === "string" ? url.trim() : "" });
          }}
          className="flex flex-col gap-1.5"
        >
          <Field label="From a git repository with a pi-cloud-profile.json">
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
