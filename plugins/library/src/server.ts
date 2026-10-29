import {
  BadRequest,
  HttpError,
  NotFound,
  type RouteCaller,
  type ServerPlugin,
} from "@pipoca/plugins";
import type { Actor } from "@pipoca/protocol";
import { type LibraryStore, libraryStore } from "./library";
import { fileLimit, nameRule, sizeRule, validName } from "./model";

export const library: ServerPlugin = {
  name: "library",
  register: (context) => {
    const store = libraryStore(context.store);

    context.events.subscribe("projects.MemberAdded", (event) => {
      const { sessionId, projectId } = event;
      if (typeof sessionId === "string" && typeof projectId === "string") {
        store.addMember(sessionId, projectId);
      }
    });

    context.routes.handle(async (request, path, caller) => {
      const target = resolve(path.split("/"), caller, store);

      if (target === undefined) {
        throw new NotFound(`no route ${path}`);
      }

      const response = await serve(
        request,
        target,
        caller.actor,
        store,
        fileLimit(context.settings.get()),
      );

      if (request.method === "PUT" && response.ok) {
        context.log("library file written", {
          project: target.projectId,
          name: target.name,
          actor: caller.actor,
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
  caller: RouteCaller,
  store: LibraryStore,
): Target | undefined {
  if (caller.kind === "session") {
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

// macOS and zip archives often spell "é" as "e" plus a combining accent; NFC
// makes both spellings one file.
function decoded(name: string | undefined): string | undefined {
  if (name === undefined || name === "") {
    return undefined;
  }

  try {
    return decodeURIComponent(name).normalize("NFC");
  } catch (error) {
    throw new BadRequest((error as Error).message);
  }
}

async function serve(
  request: Request,
  { projectId, resource, name }: Target,
  actor: Actor,
  store: LibraryStore,
  limit: number,
): Promise<Response> {
  if (resource === "member" && request.method === "GET") {
    return Response.json({ projectId });
  }

  if (resource === "log" && request.method === "GET") {
    return Response.json(store.writes(projectId));
  }

  if (
    resource !== "files" ||
    (name === undefined && request.method !== "GET")
  ) {
    throw new NotFound("no such library route");
  }

  if (name === undefined) {
    return Response.json(store.files(projectId));
  }

  if (request.method === "GET") {
    const content = store.read(projectId, name);

    if (content === undefined) {
      throw new NotFound(`no library file ${name}`);
    }

    return new Response(content, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": attachment(name),
      },
    });
  }

  if (request.method !== "PUT") {
    throw new NotFound("no such library route");
  }

  if (!validName(name)) {
    throw new BadRequest(nameRule);
  }

  const content = new Uint8Array(await request.arrayBuffer());
  if (content.length > limit) {
    throw new HttpError(413, sizeRule(limit));
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
