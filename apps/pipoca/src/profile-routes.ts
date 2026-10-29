import { BadRequest, fieldsOf, readJson } from "@pipoca/plugins";
import type { Profiles } from "@pipoca/profiles";
import type { Log } from "@pipoca/providers";
import { errorReply, notFound, reply } from "./replies";
import type { BrowserRoute } from "./server";

const profileRejections = {
  not_found: [404, "There is no such Profile."],
  default: [409, "The default Profile can't be removed."],
  in_use: [409, "Sessions still use this Profile."],
  admin_only: [403, "Only admins change shared Profiles."],
} as const;

// Shared Profiles are changed only by admins (ADR 0041).
export function profileRoutes(
  profiles: Profiles,
  log: Log,
): readonly (readonly [string, RegExp, BrowserRoute])[] {
  const replied = (
    result: ReturnType<
      | Profiles["create"]
      | Profiles["update"]
      | Profiles["updateBase"]
      | Profiles["remove"]
    >,
    status: number,
  ): Response =>
    result.ok
      ? reply(result, status)
      : errorReply(
          profileRejections[result.reason][0],
          result.reason,
          profileRejections[result.reason][1],
        );

  return [
    ["GET", /^\/api\/profiles$/, () => Response.json(profiles.list())],
    [
      "POST",
      /^\/api\/profiles$/,
      async (request, _params, _actor, admin) => {
        const created = profiles.create(await readJson(request), admin);

        if (created.ok) {
          log("profile created", { profileId: created.value.id });
        }

        return replied(created, 201);
      },
    ],
    // A body with a url imports from a git repository, any other body is an
    // exported Profile file.
    [
      "POST",
      /^\/api\/profiles\/import$/,
      async (request) => {
        if (request.headers.get("content-type") === "application/gzip") {
          const name = new URL(request.url).searchParams.get("name") ?? "";

          const imported = await profiles.importArchive(
            name.trim() === "" ? "Imported" : name,
            await request.bytes(),
          );

          log("profile imported", { profileId: imported.id });

          return Response.json(imported, { status: 201 });
        }

        const body = await readJson(request);

        const { url } = (body ?? {}) as Record<string, unknown>;

        if (url !== undefined && typeof url !== "string") {
          throw new BadRequest("url must be a string");
        }

        const profile =
          url === undefined
            ? profiles.import(body)
            : await profiles.importFromGit(url);

        log("profile imported", { profileId: profile.id });

        return Response.json(profile, { status: 201 });
      },
    ],
    [
      "GET",
      /^\/api\/profiles\/([^/]+)$/,
      (_request, [id = ""]) => {
        const profile = profiles.get(id);

        return profile ? Response.json(profile) : notFound();
      },
    ],
    [
      "PUT",
      /^\/api\/profiles\/([^/]+)$/,
      async (request, [id = ""], _actor, admin) => {
        const updated = profiles.update(id, await readJson(request), admin);

        if (updated.ok) {
          log("profile updated", { profileId: id });
        }

        return replied(updated, 200);
      },
    ],
    [
      "DELETE",
      /^\/api\/profiles\/([^/]+)$/,
      (_request, [id = ""], _actor, admin) => {
        const removed = profiles.remove(id, admin);
        if (removed.ok) {
          log("profile deleted", { profileId: id });
        }

        return replied(removed, 204);
      },
    ],
    [
      "POST",
      /^\/api\/profiles\/([^/]+)\/default$/,
      (_request, [id = ""]) => replied(profiles.makeDefault(id), 200),
    ],
    [
      "GET",
      /^\/api\/profiles\/([^/]+)\/export$/,
      async (_request, [id = ""]) => {
        const archive = await profiles.archive(id);
        if (!archive) {
          return notFound();
        }

        return new Response(archive, {
          headers: {
            "content-type": "application/gzip",
            "content-disposition": `attachment; filename="${id}.tar.gz"`,
          },
        });
      },
    ],
    // The admin's base Profile (ADR 0044).
    ["GET", /^\/api\/base$/, () => Response.json(profiles.base())],
    [
      "PUT",
      /^\/api\/base$/,
      async (request, _params, _actor, admin) => {
        const updated = profiles.updateBase(await readJson(request), admin);

        if (updated.ok) {
          log("base profile updated");
        }

        return replied(updated, 200);
      },
    ],
    ["GET", /^\/api\/base\/files$/, () => Response.json(profiles.baseFiles())],
    [
      "POST",
      /^\/api\/base\/files$/,
      async (request, _params, _actor, admin) => {
        const files = uploadedFiles(await readJson(request));
        const written = profiles.writeBaseFiles(files, admin);
        if (written.ok) {
          log("base profile files uploaded", { files: files.size });
        }

        return replied(written, 204);
      },
    ],
    [
      "GET",
      /^\/api\/base\/files\/(.+)$/,
      (_request, [path = ""]) => {
        const file = profiles.baseFile(filePath(path));

        return file ? new Response(file) : notFound();
      },
    ],
    [
      "PUT",
      /^\/api\/base\/files\/(.+)$/,
      async (request, [path = ""], _actor, admin) => {
        const written = profiles.writeBaseFiles(
          new Map([[filePath(path), Buffer.from(await request.bytes())]]),
          admin,
        );

        if (written.ok) {
          log("base profile file written");
        }

        return replied(written, 204);
      },
    ],
    [
      "DELETE",
      /^\/api\/base\/files\/(.+)$/,
      (_request, [path = ""], _actor, admin) => {
        const removed = profiles.deleteBaseFile(filePath(path), admin);

        if (removed.ok) {
          log("base profile file deleted");
        }

        return replied(removed, 204);
      },
    ],
    // A Profile's folder, file by file (ADR 0041).
    [
      "GET",
      /^\/api\/profiles\/([^/]+)\/files$/,
      (_request, [id = ""]) => {
        const files = profiles.files(id);

        return files ? Response.json(files) : notFound();
      },
    ],
    // Uploads files and folders as { files: { path: base64 } }, the way
    // runners get them.
    [
      "POST",
      /^\/api\/profiles\/([^/]+)\/files$/,
      async (request, [id = ""], _actor, admin) => {
        const decoded = uploadedFiles(await readJson(request));
        const written = profiles.writeFiles(id, decoded, admin);
        if (written.ok) {
          log("profile files uploaded", {
            profileId: id,
            files: decoded.size,
          });
        }

        return replied(written, 204);
      },
    ],
    [
      "GET",
      /^\/api\/profiles\/([^/]+)\/files\/(.+)$/,
      (_request, [id = "", path = ""]) => {
        const file = profiles.file(id, filePath(path));

        return file ? new Response(file) : notFound();
      },
    ],
    [
      "PUT",
      /^\/api\/profiles\/([^/]+)\/files\/(.+)$/,
      async (request, [id = "", path = ""], _actor, admin) => {
        const written = profiles.writeFiles(
          id,
          new Map([[filePath(path), Buffer.from(await request.bytes())]]),
          admin,
        );

        if (written.ok) {
          log("profile file written", { profileId: id });
        }

        return replied(written, 204);
      },
    ],
    [
      "DELETE",
      /^\/api\/profiles\/([^/]+)\/files\/(.+)$/,
      (_request, [id = "", path = ""], _actor, admin) => {
        const removed = profiles.deleteFile(id, filePath(path), admin);

        if (removed.ok) {
          log("profile file deleted", { profileId: id });
        }

        return replied(removed, 204);
      },
    ],
  ];
}

function uploadedFiles(body: unknown): Map<string, Buffer> {
  const { files } = fieldsOf(body);
  if (
    typeof files !== "object" ||
    files === null ||
    Object.values(files).some((content) => typeof content !== "string")
  ) {
    throw new BadRequest("files must map paths to base64 contents");
  }

  return new Map(
    Object.entries(files as Record<string, string>).map(([path, content]) => [
      path,
      Buffer.from(content, "base64"),
    ]),
  );
}

// A file's path as it arrives in a URL, percent-encoded.
function filePath(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new BadRequest("path isn't valid percent-encoding");
  }
}
