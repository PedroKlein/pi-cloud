import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  PiPackage,
  Profile,
  ProfileContent,
  ProfileExport,
} from "@pi-cloud/protocol";

export type StoredProfile = Omit<Profile, "isDefault">;

export interface ProfileStore {
  readonly profiles: (ownerId: string) => readonly StoredProfile[];
  readonly profile: (id: string) => StoredProfile | undefined;
  readonly insertProfile: (profile: StoredProfile) => void;
  readonly updateProfile: (profile: StoredProfile) => void;
  readonly deleteProfile: (id: string) => void;
  readonly defaultProfileId: (ownerId: string) => string;
  readonly setDefaultProfile: (ownerId: string, id: string) => void;
  // Unarchived Sessions that run with the Profile.
  readonly profileInUse: (id: string) => boolean;
}

export class InvalidProfile extends Error {}

type Rejection = "not_found" | "default" | "in_use";

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: Rejection };

// The file a repository shares a Profile in, at its root.
const exportFile = "pi-cloud-profile.json";
const gitTimeoutMs = 60_000;
const maxExportBytes = 1024 * 1024;
const run = promisify(execFile);

export class Profiles {
  readonly #store: ProfileStore;
  readonly #ownerId: string;

  constructor(store: ProfileStore, ownerId: string) {
    this.#store = store;
    this.#ownerId = ownerId;
  }

  list(): readonly Profile[] {
    const defaultId = this.#store.defaultProfileId(this.#ownerId);

    return this.#store
      .profiles(this.#ownerId)
      .map((profile) => ({ ...profile, isDefault: profile.id === defaultId }));
  }

  get(id: string): Profile | undefined {
    const profile = this.#owned(id);

    return profile && this.#view(profile);
  }

  // Throws InvalidProfile when the body isn't a name with Profile content.
  create(body: unknown): Profile {
    const fields = fieldsOf(body);

    const profile: StoredProfile = {
      id: randomUUID(),
      name: nameOf(fields["name"]),
      ownerId: this.#ownerId,
      createdAt: new Date().toISOString(),
      ...contentOf(fields),
    };

    this.#store.insertProfile(profile);

    return this.#view(profile);
  }

  // Edits reach a Session the next time its Pi process starts (ADR 0031).
  update(id: string, body: unknown): Result<Profile> {
    const profile = this.#owned(id);
    if (!profile) {
      return { ok: false, reason: "not_found" };
    }

    const fields = fieldsOf(body);

    const updated: StoredProfile = {
      ...profile,
      ...(fields["name"] !== undefined && { name: nameOf(fields["name"]) }),
      ...contentOf({ ...profile, ...fields }),
    };

    this.#store.updateProfile(updated);

    return { ok: true, value: this.#view(updated) };
  }

  remove(id: string): Result<undefined> {
    if (!this.#owned(id)) {
      return { ok: false, reason: "not_found" };
    }

    if (this.#store.defaultProfileId(this.#ownerId) === id) {
      return { ok: false, reason: "default" };
    }

    if (this.#store.profileInUse(id)) {
      return { ok: false, reason: "in_use" };
    }

    this.#store.deleteProfile(id);

    return { ok: true, value: undefined };
  }

  makeDefault(id: string): Result<Profile> {
    const profile = this.#owned(id);
    if (!profile) {
      return { ok: false, reason: "not_found" };
    }

    this.#store.setDefaultProfile(this.#ownerId, id);

    return { ok: true, value: this.#view(profile) };
  }

  exportOf(id: string): ProfileExport | undefined {
    const profile = this.#owned(id);
    if (!profile) {
      return undefined;
    }

    const { name, packages, agentsMd, systemMd, appendSystemMd } = profile;
    const { mcpServers, settings } = profile;

    return {
      piCloudProfile: 1,
      name,
      packages,
      agentsMd,
      systemMd,
      appendSystemMd,
      mcpServers,
      settings,
    };
  }

  // An import is a copy the importer owns (ADR 0031).
  import(file: unknown): Profile {
    if (fieldsOf(file)["piCloudProfile"] !== 1) {
      throw new InvalidProfile("not a Pi Cloud Profile file");
    }

    return this.create(file);
  }

  // The server clones with its own git setup, so only remote https and ssh
  // URLs are taken, with no stored credentials, and the file must be a small
  // regular file.
  async importFromGit(url: string): Promise<Profile> {
    if (!/^(https:\/\/|ssh:\/\/)[^\s]+$/.test(url)) {
      throw new InvalidProfile("url must be an https:// or ssh:// git URL");
    }

    const dir = await mkdtemp(join(tmpdir(), "pi-cloud-profile-"));
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

      const file = join(dir, exportFile);
      const info = await lstat(file).catch(() => undefined);
      if (info?.isFile() !== true || info.size > maxExportBytes) {
        throw new InvalidProfile(`${url} has no ${exportFile} to import`);
      }

      return this.import(parsedJson(await readFile(file, "utf8")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  #owned(id: string): StoredProfile | undefined {
    const profile = this.#store.profile(id);

    return profile?.ownerId === this.#ownerId ? profile : undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
