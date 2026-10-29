import type { PluginStore } from "@pipoca/plugins";
import type { Actor } from "@pipoca/protocol";
import type { LibraryFile, LibraryWrite } from "./model";

interface FileRow {
  readonly name: string;
  readonly size: number;
  readonly actor: string;
  readonly updated_at: string;
}

export interface LibraryStore {
  readonly addMember: (sessionId: string, projectId: string) => void;
  readonly projectOf: (sessionId: string) => string | undefined;
  readonly members: (projectId: string) => readonly string[];
  readonly files: (projectId: string) => readonly LibraryFile[];
  readonly read: (projectId: string, name: string) => Uint8Array | undefined;
  readonly write: (
    projectId: string,
    name: string,
    content: Uint8Array,
    actor: Actor,
  ) => void;
  readonly writes: (projectId: string) => readonly LibraryWrite[];
}

export function libraryStore(store: PluginStore): LibraryStore {
  store.exec(`create table if not exists library_members (
    session_id text primary key,
    project_id text not null
  )`);

  store.exec(`create table if not exists library_files (
    project_id text not null,
    name text not null,
    content blob not null,
    size integer not null,
    actor text not null,
    updated_at text not null,
    primary key (project_id, name)
  )`);

  store.exec(
    "create index if not exists library_files_listing on library_files (project_id, name, size, actor, updated_at)",
  );

  store.exec(`create table if not exists library_log (
    project_id text not null,
    name text not null,
    size integer not null,
    actor text not null,
    at text not null
  )`);

  return {
    addMember: (sessionId, projectId) => {
      store.run(
        "insert or replace into library_members (session_id, project_id) values (?, ?)",
        sessionId,
        projectId,
      );
    },
    projectOf: (sessionId) =>
      (
        store.all(
          "select project_id from library_members where session_id = ?",
          sessionId,
        )[0] as { project_id: string } | undefined
      )?.project_id,
    members: (projectId) =>
      (
        store.all(
          "select session_id from library_members where project_id = ?",
          projectId,
        ) as { session_id: string }[]
      ).map((row) => row.session_id),
    files: (projectId) =>
      (
        store.all(
          "select name, size, actor, updated_at from library_files where project_id = ? order by name",
          projectId,
        ) as FileRow[]
      ).map((row) => ({
        name: row.name,
        size: row.size,
        actor: row.actor,
        updatedAt: row.updated_at,
      })),
    read: (projectId, name) =>
      (
        store.all(
          "select content from library_files where project_id = ? and name = ?",
          projectId,
          name,
        )[0] as { content: Uint8Array } | undefined
      )?.content,
    write: (projectId, name, content, actor) => {
      const at = new Date().toISOString();

      store.run(
        `insert or replace into library_files
          (project_id, name, content, size, actor, updated_at)
          values (?, ?, ?, ?, ?, ?)`,
        projectId,
        name,
        content,
        content.length,
        actor,
        at,
      );

      store.run(
        "insert into library_log (project_id, name, size, actor, at) values (?, ?, ?, ?, ?)",
        projectId,
        name,
        content.length,
        actor,
        at,
      );
    },
    writes: (projectId) =>
      store.all(
        "select name, size, actor, at from library_log where project_id = ? order by rowid desc limit 50",
        projectId,
      ) as LibraryWrite[],
  };
}
