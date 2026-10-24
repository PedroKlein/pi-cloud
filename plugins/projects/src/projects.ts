import type { PluginStore } from "@pi-cloud/plugins";
import type { Actor } from "@pi-cloud/protocol";
import type { MemoryFileView, ProjectNotice, Role, WorkState } from "./model";

export interface Project {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly instructions: string;
  readonly repositories: readonly string[];
  readonly environmentId: string | null;
  // The Profile new threads run with when start_thread names none (ADR 0031).
  readonly profileId: string | null;
  // provider/id for threads that start_thread gives no model.
  readonly threadModel: string | null;
  readonly coordinatorId: string;
  readonly createdAt: string;
}

export interface Member {
  readonly sessionId: string;
  readonly projectId: string;
  readonly role: Role;
  readonly title: string;
  readonly workState: WorkState;
  readonly lastActivity: string;
}

// Deliveries queued before notices existed have none.
export type Delivery =
  | {
      readonly kind: "context" | "message";
      readonly text: string;
      readonly notice?: ProjectNotice;
    }
  // end is how many transcript lines the thread's turn ended with.
  | { readonly kind: "turn"; readonly threadId: string; readonly end?: number };

export interface Queued {
  readonly id: number;
  readonly sessionId: string;
  readonly actor: Actor;
  readonly delivery: Delivery;
}

interface ProjectRow {
  id: string;
  owner_id: string;
  name: string;
  instructions: string;
  repositories: string;
  environment_id: string | null;
  profile_id: string | null;
  thread_model: string | null;
  coordinator_id: string;
  created_at: string;
}

interface MemberRow {
  session_id: string;
  project_id: string;
  role: Role;
  title: string;
  work_state: WorkState;
  last_activity: string;
}

const memoryLimit = 16 * 1024;

export interface ProjectStore {
  readonly create: (project: Project) => void;
  readonly list: () => readonly Project[];
  readonly get: (id: string) => Project | undefined;
  readonly update: (
    id: string,
    settings: Pick<
      Project,
      "name" | "instructions" | "threadModel" | "profileId"
    >,
  ) => void;
  readonly addMember: (member: Member) => void;
  readonly member: (sessionId: string) => Member | undefined;
  readonly threads: (projectId: string) => readonly Member[];
  readonly setWorkState: (sessionId: string, state: WorkState) => void;
  readonly touch: (sessionId: string) => void;
  readonly memory: (projectId: string) => readonly MemoryFileView[];
  readonly readMemory: (projectId: string, name: string) => string | undefined;
  readonly writeMemory: (
    projectId: string,
    name: string,
    content: string,
    actor: Actor,
  ) => void;
  readonly enqueue: (
    sessionId: string,
    actor: Actor,
    delivery: Delivery,
  ) => void;
  readonly queued: () => readonly Queued[];
  readonly delivered: (id: number) => void;
}

export function projectStore(
  store: PluginStore,
  memberAdded: (member: Member) => void,
): ProjectStore {
  store.exec(`create table if not exists projects_projects (
    id text primary key,
    owner_id text not null,
    name text not null,
    instructions text not null,
    repositories text not null,
    environment_id text,
    coordinator_id text not null,
    created_at text not null
  )`);

  const columns = store.all("pragma table_info(projects_projects)") as {
    name: string;
  }[];

  for (const column of ["thread_model", "profile_id"]) {
    if (!columns.some(({ name }) => name === column)) {
      store.exec(`alter table projects_projects add column ${column} text`);
    }
  }

  store.exec(`create table if not exists projects_members (
    session_id text primary key,
    project_id text not null,
    role text not null,
    title text not null,
    work_state text not null,
    last_activity text not null
  )`);

  store.exec(`create table if not exists projects_memory (
    project_id text not null,
    name text not null,
    content text not null,
    updated_at text not null,
    actor text not null,
    primary key (project_id, name)
  )`);

  store.exec(`create table if not exists projects_memory_log (
    project_id text not null,
    name text not null,
    size integer not null,
    actor text not null,
    at text not null
  )`);

  store.exec(`create table if not exists projects_outbox (
    id integer primary key autoincrement,
    session_id text not null,
    actor text not null,
    delivery text not null
  )`);

  const toProject = (row: ProjectRow): Project => ({
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    instructions: row.instructions,
    repositories: JSON.parse(row.repositories) as string[],
    environmentId: row.environment_id,
    profileId: row.profile_id,
    threadModel: row.thread_model,
    coordinatorId: row.coordinator_id,
    createdAt: row.created_at,
  });

  const toMember = (row: MemberRow): Member => ({
    sessionId: row.session_id,
    projectId: row.project_id,
    role: row.role,
    title: row.title,
    workState: row.work_state,
    lastActivity: row.last_activity,
  });

  // A delivery marked delivered is never read back, even when its delete
  // failed: the delete is tried again before the queue is read, so nothing is
  // sent twice.
  const deliveredIds = new Set<number>();

  const deleteDelivered = (): void => {
    for (const id of deliveredIds) {
      store.run("delete from projects_outbox where id = ?", id);
      deliveredIds.delete(id);
    }
  };

  return {
    create: (project) => {
      store.run(
        `insert into projects_projects
          (id, owner_id, name, instructions, repositories, environment_id, profile_id, thread_model, coordinator_id, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        project.id,
        project.ownerId,
        project.name,
        project.instructions,
        JSON.stringify(project.repositories),
        project.environmentId,
        project.profileId,
        project.threadModel,
        project.coordinatorId,
        project.createdAt,
      );
    },
    list: () =>
      (
        store.all(
          "select * from projects_projects order by created_at",
        ) as ProjectRow[]
      ).map(toProject),
    get: (id) => {
      const [row] = store.all(
        "select * from projects_projects where id = ?",
        id,
      ) as ProjectRow[];

      return row && toProject(row);
    },
    update: (id, { name, instructions, threadModel, profileId }) => {
      store.run(
        `update projects_projects
          set name = ?, instructions = ?, thread_model = ?, profile_id = ? where id = ?`,
        name,
        instructions,
        threadModel,
        profileId,
        id,
      );
    },
    addMember: (member) => {
      store.run(
        `insert into projects_members
          (session_id, project_id, role, title, work_state, last_activity)
          values (?, ?, ?, ?, ?, ?)`,
        member.sessionId,
        member.projectId,
        member.role,
        member.title,
        member.workState,
        member.lastActivity,
      );

      memberAdded(member);
    },
    member: (sessionId) => {
      const [row] = store.all(
        "select * from projects_members where session_id = ?",
        sessionId,
      ) as MemberRow[];

      return row && toMember(row);
    },
    threads: (projectId) =>
      (
        store.all(
          `select * from projects_members
            where project_id = ? and role = 'thread'
            order by rowid`,
          projectId,
        ) as MemberRow[]
      ).map(toMember),
    setWorkState: (sessionId, state) => {
      store.run(
        "update projects_members set work_state = ? where session_id = ?",
        state,
        sessionId,
      );
    },
    touch: (sessionId) => {
      store.run(
        "update projects_members set last_activity = ? where session_id = ?",
        new Date().toISOString(),
        sessionId,
      );
    },
    memory: (projectId) =>
      (
        store.all(
          `select name, length(cast(content as blob)) as size, updated_at, actor
            from projects_memory where project_id = ? order by name`,
          projectId,
        ) as { name: string; size: number; updated_at: string; actor: string }[]
      ).map((row) => ({
        name: row.name,
        size: row.size,
        updatedAt: row.updated_at,
        actor: row.actor,
      })),
    readMemory: (projectId, name) => {
      const [row] = store.all(
        "select content from projects_memory where project_id = ? and name = ?",
        projectId,
        name,
      ) as { content: string }[];

      return row?.content;
    },
    writeMemory: (projectId, name, content, actor) => {
      const size = new TextEncoder().encode(content).length;

      if (size > memoryLimit) {
        throw new Error(
          `memory files are limited to ${String(memoryLimit / 1024)} KB`,
        );
      }

      const at = new Date().toISOString();

      store.run(
        `insert into projects_memory (project_id, name, content, updated_at, actor)
          values (?, ?, ?, ?, ?)
          on conflict (project_id, name) do update set
            content = excluded.content,
            updated_at = excluded.updated_at,
            actor = excluded.actor`,
        projectId,
        name,
        content,
        at,
        actor,
      );

      store.run(
        `insert into projects_memory_log (project_id, name, size, actor, at)
          values (?, ?, ?, ?, ?)`,
        projectId,
        name,
        size,
        actor,
        at,
      );
    },
    enqueue: (sessionId, actor, delivery) => {
      store.run(
        "insert into projects_outbox (session_id, actor, delivery) values (?, ?, ?)",
        sessionId,
        actor,
        JSON.stringify(delivery),
      );
    },
    queued: () => {
      deleteDelivered();

      return (
        store.all("select * from projects_outbox order by id") as {
          id: number;
          session_id: string;
          actor: Actor;
          delivery: string;
        }[]
      ).map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        actor: row.actor,
        delivery: JSON.parse(row.delivery) as Delivery,
      }));
    },
    delivered: (id) => {
      deliveredIds.add(id);
      deleteDelivered();
    },
  };
}
