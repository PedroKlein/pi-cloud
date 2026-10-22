import type { ServerPlugin, ToolCaller } from "@pi-cloud/plugins";
import type { Actor } from "@pi-cloud/protocol";
import { type LibraryStore, libraryStore } from "./library";
import { fileLimit, nameRule, sizeRule, validName } from "./model";

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
      let target: Target | undefined;
      try {
        target = resolve(path.split("/"), caller, store);
      } catch (error) {
        if (error instanceof URIError) {
          return Response.json({ error: error.message }, { status: 400 });
        }

        throw error;
      }

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
    return request.method === "GET"
      ? Response.json(store.files(projectId))
      : Response.json({ error: "not_found" }, { status: 404 });
  }

  if (request.method === "GET") {
    const content = store.read(projectId, name);

    return content === undefined
      ? Response.json({ error: `no library file ${name}` }, { status: 404 })
      : new Response(content, {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": attachment(name),
          },
        });
  }

  if (request.method !== "PUT") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  if (!validName(name)) {
    return Response.json({ error: nameRule }, { status: 400 });
  }

  const content = new Uint8Array(await request.arrayBuffer());
  if (content.length > fileLimit) {
    return Response.json({ error: sizeRule }, { status: 413 });
  }

  store.write(projectId, name, content, actor);

  return Response.json({ name, size: content.length });
}

// RFC 8187 leaves ' ( ) and * out of filename*, but encodeURIComponent keeps them.
function attachment(name: string): string {
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename*=UTF-8''${encoded}`;
}
