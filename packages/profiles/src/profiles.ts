import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  type PiPackage,
  type Profile,
  type ProfileContent,
  profilePath,
} from "@pipoca/protocol";
import {
  defaultProfileId,
  isRecord,
  type ProfileFolders,
  type StoredProfile,
} from "./folders";
import { folderEntries } from "./files";
import { InvalidProfile } from "./invalid";

export interface ProfileStore {
  readonly defaultProfileId: (ownerId: string) => string;
  readonly setDefaultProfile: (ownerId: string, id: string) => void;
  // Unarchived Sessions that run with the Profile.
  readonly profileInUse: (id: string) => boolean;
}

type Rejection = "not_found" | "default" | "in_use" | "admin_only";

export interface ProfileEntry {
  readonly path: string;
  readonly size: number;
}

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: Rejection };

// The file a repository shares a Profile in, at its root.
const exportFile = "pipoca-profile.json";
const gitTimeoutMs = 60_000;
const maxExportBytes = 1024 * 1024;
const run = promisify(execFile);

// The Profiles a user sees: their own and the shared ones, which only admins
// change (ADR 0041).
export class Profiles {
  readonly #folders: ProfileFolders;
  readonly #store: ProfileStore;
  readonly #ownerId: string;

  constructor(folders: ProfileFolders, store: ProfileStore, ownerId: string) {
    this.#folders = folders;
    this.#store = store;
    this.#ownerId = ownerId;
  }

  list(): readonly Profile[] {
    return this.#folders
      .ids()
      .flatMap((id) => {
        const profile = this.#visible(id);

        return profile ? [this.#view(profile)] : [];
      })
      .sort(
        (a, b) =>
          Number(b.id === defaultProfileId) -
            Number(a.id === defaultProfileId) || a.name.localeCompare(b.name),
      );
  }

  get(id: string): Profile | undefined {
    const profile = this.#visible(id);

    return profile && this.#view(profile);
  }

  // Throws InvalidProfile when the body isn't a name with Profile content.
  create(body: unknown, admin: boolean): Result<Profile> {
    const fields = fieldsOf(body);
    const name = nameOf(fields["name"]);
    const content = contentOf(fields);

    if (fields["shared"] === true && !admin) {
      return { ok: false, reason: "admin_only" };
    }

    const profile: StoredProfile = {
      id: this.#folders.freeId(name),
      name,
      ownerId: fields["shared"] === true ? null : this.#ownerId,
      createdAt: new Date().toISOString(),
      ...content,
    };

    this.#folders.write(profile.id, profile, content);

    return { ok: true, value: this.#view(profile) };
  }

  // Edits reach a Session the next time its Pi process starts (ADR 0031).
  update(id: string, body: unknown, admin: boolean): Result<Profile> {
    const profile = this.#visible(id);
    if (!profile) {
      return { ok: false, reason: "not_found" };
    }

    if (profile.ownerId === null && !admin) {
      return { ok: false, reason: "admin_only" };
    }

    const fields = fieldsOf(body);
    const content = contentOf({ ...profile, ...fields });

    const updated: StoredProfile = {
      ...profile,
      ...(fields["name"] !== undefined && { name: nameOf(fields["name"]) }),
      ...content,
    };

    const given = Object.fromEntries(
      Object.entries(content).filter(([key]) => key in fields),
    );

    this.#folders.write(id, updated, given);

    return { ok: true, value: this.#view(updated) };
  }

  remove(id: string, admin: boolean): Result<undefined> {
    const profile = this.#visible(id);
    if (!profile) {
      return { ok: false, reason: "not_found" };
    }

    if (profile.ownerId === null && !admin) {
      return { ok: false, reason: "admin_only" };
    }

    if (
      id === defaultProfileId ||
      this.#store.defaultProfileId(this.#ownerId) === id
    ) {
      return { ok: false, reason: "default" };
    }

    if (this.#store.profileInUse(id)) {
      return { ok: false, reason: "in_use" };
    }

    this.#folders.remove(id);

    return { ok: true, value: undefined };
  }

  makeDefault(id: string): Result<Profile> {
    const profile = this.#visible(id);
    if (!profile) {
      return { ok: false, reason: "not_found" };
    }

    this.#store.setDefaultProfile(this.#ownerId, id);

    return { ok: true, value: this.#view(profile) };
  }

  // A Profile's files, as a .tar.gz runners would unpack to the same folder
  // (ADR 0041).
  async archive(id: string): Promise<Uint8Array | undefined> {
    const files = this.#visible(id) && this.#folders.files(id);
    if (!files) {
      return undefined;
    }

    const decoded = Object.fromEntries(
      Object.entries(files.files).map(([path, content]) => [
        path,
        Buffer.from(content, "base64"),
      ]),
    );

    return new Bun.Archive(decoded, { compress: "gzip" }).bytes();
  }

  files(id: string): readonly ProfileEntry[] | undefined {
    return this.#visible(id) && this.#folders.entries(id);
  }

  file(id: string, path: string): Buffer | undefined {
    return this.#visible(id) && this.#folders.file(id, path);
  }

  // Throws InvalidProfile for a path a Profile can't hold, and ProfileTooBig.
  writeFiles(
    id: string,
    files: ReadonlyMap<string, Buffer>,
    admin: boolean,
  ): Result<undefined> {
    const denied = this.#denied(id, admin);
    if (denied) {
      return denied;
    }

    this.#folders.writeFiles(id, files);

    return { ok: true, value: undefined };
  }

  deleteFile(id: string, path: string, admin: boolean): Result<undefined> {
    const denied = this.#denied(id, admin);
    if (denied) {
      return denied;
    }

    return this.#folders.deleteFile(id, path)
      ? { ok: true, value: undefined }
      : { ok: false, reason: "not_found" };
  }

  // A .tar.gz of a Pi agent folder, such as an exported Profile or someone's
  // own ~/.pi/agent. What machines keep for themselves, such as auth.json,
  // is left out.
  async importArchive(name: string, archive: Uint8Array): Promise<Profile> {
    const entries = await new Bun.Archive(archive).files().catch(() => {
      throw new InvalidProfile("that file isn't a .tar.gz");
    });

    const files = new Map<string, Buffer>();
    for (const [path, file] of entries) {
      const relative = path.replace(/^(\.\/)+/, "");
      if (profilePath(relative)) {
        files.set(relative, Buffer.from(await file.arrayBuffer()));
      }
    }

    return this.#createWith(name, files);
  }

  // An import is a copy the importer owns (ADR 0031).
  import(file: unknown): Profile {
    const fields = fieldsOf(file);
    if (fields["pipocaProfile"] !== 1) {
      throw new InvalidProfile("not a Pipoca Profile file");
    }

    const { shared: _ignored, ...owned } = fields;
    const created = this.create(owned, false);
    if (!created.ok) {
      throw new InvalidProfile(created.reason);
    }

    return created.value;
  }

  // The server clones with its own git setup, so only remote https and ssh
  // URLs are taken, with no stored credentials, and the file must be a small
  // regular file.
  async importFromGit(url: string): Promise<Profile> {
    if (!/^(https:\/\/|ssh:\/\/)[^\s]+$/.test(url)) {
      throw new InvalidProfile("url must be an https:// or ssh:// git URL");
    }

    const dir = await mkdtemp(join(tmpdir(), "pipoca-profile-"));
    try {
      await run(
        "git",
        [
          "-c",
          "protocol.allow=never",
          "-c",
          "protocol.https.allow=always",
          "-c",
          "protocol.ssh.allow=always",
          "-c",
          "credential.helper=",
          "clone",
          "--depth",
          "1",
          "--",
          url,
          dir,
        ],
        {
          timeout: gitTimeoutMs,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
      ).catch(() => {
        throw new InvalidProfile(`could not clone ${url}`);
      });

      // Repositories made before Profiles were folders hold one file.
      const file = join(dir, exportFile);
      const info = await lstat(file).catch(() => undefined);
      if (info?.isFile() === true && info.size <= maxExportBytes) {
        return this.import(parsedJson(await readFile(file, "utf8")));
      }

      const files = new Map(
        folderEntries(dir).map(({ path }) => [
          path,
          readFileSync(join(dir, path)),
        ]),
      );

      return this.#createWith(basename(url).replace(/\.git$/, ""), files);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  #createWith(name: string, files: ReadonlyMap<string, Buffer>): Profile {
    const created = this.create({ name }, false);
    if (!created.ok) {
      throw new InvalidProfile(created.reason);
    }

    try {
      this.#folders.writeFiles(created.value.id, files);
    } catch (error) {
      this.#folders.remove(created.value.id);
      throw error;
    }

    return this.#view(this.#folders.read(created.value.id) ?? created.value);
  }

  #denied(
    id: string,
    admin: boolean,
  ): { readonly ok: false; readonly reason: Rejection } | undefined {
    const profile = this.#visible(id);
    if (!profile) {
      return { ok: false, reason: "not_found" };
    }

    return profile.ownerId === null && !admin
      ? { ok: false, reason: "admin_only" }
      : undefined;
  }

  #visible(id: string): StoredProfile | undefined {
    const profile = this.#folders.read(id);

    return profile?.ownerId === null || profile?.ownerId === this.#ownerId
      ? profile
      : undefined;
  }

  #view(profile: StoredProfile): Profile {
    return {
      ...profile,
      isDefault: this.#store.defaultProfileId(this.#ownerId) === profile.id,
    };
  }
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidProfile(`${exportFile} is not JSON`);
  }
}

function fieldsOf(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new InvalidProfile("body must be an object");
  }

  return value;
}

function nameOf(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidProfile("name must be a non-empty string");
  }

  return value.trim();
}

function contentOf(fields: Record<string, unknown>): ProfileContent {
  const settings = objectOf("settings", fields["settings"]);
  if ("packages" in settings) {
    throw new InvalidProfile("settings can't hold packages; use packages");
  }

  return {
    packages: packagesOf(fields["packages"]),
    agentsMd: textOf("agentsMd", fields["agentsMd"]),
    systemMd: textOf("systemMd", fields["systemMd"]),
    appendSystemMd: textOf("appendSystemMd", fields["appendSystemMd"]),
    mcpServers: objectOf("mcpServers", fields["mcpServers"]),
    settings,
  };
}

function textOf(key: string, value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value !== "string") {
    throw new InvalidProfile(`${key} must be a string`);
  }

  return value;
}

function objectOf(key: string, value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isRecord(value)) {
    throw new InvalidProfile(`${key} must be an object`);
  }

  return value;
}

function packagesOf(value: unknown): readonly PiPackage[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new InvalidProfile("packages must be a list");
  }

  return value.map(packageOf);
}

const filters = ["extensions", "skills", "prompts", "themes"] as const;

function packageOf(value: unknown): PiPackage {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }

  if (
    !isRecord(value) ||
    typeof value["source"] !== "string" ||
    value["source"].trim() === ""
  ) {
    throw new InvalidProfile(
      "each package must be a source or an object with a source",
    );
  }

  const { autoload } = value;
  if (autoload !== undefined && typeof autoload !== "boolean") {
    throw new InvalidProfile("a package's autoload must be true or false");
  }

  const filtered = filters.flatMap((key) => {
    const list = value[key];
    if (list === undefined) {
      return [];
    }

    if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) {
      throw new InvalidProfile(`a package's ${key} must be a list of strings`);
    }

    return [[key, list] as const];
  });

  return {
    source: value["source"].trim(),
    ...(autoload !== undefined && { autoload }),
    ...Object.fromEntries(filtered),
  };
}
