import type { ServerPlugin, ToolCaller } from "@pi-cloud/plugins";
import type { Actor } from "@pi-cloud/protocol";
import { type LibraryStore, libraryStore } from "./library";
import { fileLimit, validName } from "./model";

export const library: ServerPlugin = {
  name: "library",
  register: (context) => {
    const store = libraryStore(context.store);
    const user: Actor = `user:${context.owner}`;

    context.events.subscribe("projects.MemberAdded", (event) => {
      const { sessionId, projectId } = event;
      if (typeof sessionId === "string" && typeof projectId === "string") {
        store.addMember(sessionId, projectId);
      }
    });

    context.routes.handle(async (request, path, caller) => {
      const target = resolve(path.split("/"), caller, store);
      if (target === undefined) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }

      const response = await serve(
        request,
        target,
        caller?.actor ?? user,
        store,
      );

      if (request.method === "PUT" && response.ok) {
        context.log("library file written", {
          project: target.projectId,
          name: target.name,
          actor: caller?.actor ?? user,
        });
      }

      return response;
    });
  },
};

interface Target {
  readonly projectId: string;
  readonly resource: string | undefined;
  readonly name: string | undefined;
}

// A Session reaches its own Project's library at files/...; the web app
// names the Project: projects/<id>/files/...
function resolve(
  path: readonly string[],
  caller: ToolCaller | undefined,
  store: LibraryStore,
): Target | undefined {
  if (caller) {
    const projectId = store.projectOf(caller.session.id);
    const [resource, name] = path;

    return projectId === undefined
      ? undefined
      : { projectId, resource, name: decoded(name) };
  }

  const [projects, projectId, resource, name] = path;

  return projects === "projects" && projectId !== undefined
    ? { projectId, resource, name: decoded(name) }
    : undefined;
}

function decoded(name: string | undefined): string | undefined {
  return name === undefined || name === ""
    ? undefined
    : decodeURIComponent(name);
}

async function serve(
  request: Request,
  { projectId, resource, name }: Target,
  actor: Actor,
  store: LibraryStore,
): Promise<Response> {
  if (resource === "member" && request.method === "GET") {
    return Response.json({ projectId });
  }

  if (resource === "log" && request.method === "GET") {
    return Response.json(store.writes(projectId));
  }

  if (resource !== "files") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  if (name === undefined) {
    return Response.json(store.files(projectId));
  }

  if (request.method === "GET") {
    const content = store.read(projectId, name);

    return content === undefined
      ? Response.json({ error: `no library file ${name}` }, { status: 404 })
      : new Response(content, {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          },
        });
  }

  if (request.method !== "PUT") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  if (!validName(name)) {
    return Response.json(
      { error: "file names may use letters, digits, spaces, . _ and -" },
      { status: 400 },
    );
  }

  const content = new Uint8Array(await request.arrayBuffer());
  if (content.length > fileLimit) {
    return Response.json(
      {
        error: `library files are limited to ${String(fileLimit / 1024 / 1024)} MB`,
      },
      { status: 413 },
    );
  }

  store.write(projectId, name, content, actor);

  return Response.json({ name, size: content.length });
}
