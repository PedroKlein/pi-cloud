# Writing a plugin

A plugin adds a feature to Pipoca for everyone on one server. It can answer HTTP routes and register tools on the server, add a page or panels to the web app, and add commands, tools and Pi packages to Sessions. The built-in plugins in `plugins/` use the same interface. This guide covers plugins you install yourself ([ADR 0022](adr/0022-plugin-model-v2.md)).

The example in [`examples/plugins/greeter`](../examples/plugins/greeter) has all three parts, and a test runs it on every change.

## Make the folder

A plugin is a folder with a `package.json`. The `pipoca` field is its manifest:

```json
{
  "name": "pipoca-greeter",
  "version": "1.0.0",
  "type": "module",
  "pipoca": {
    "id": "greeter",
    "title": "Greeter",
    "description": "Greets you on its own page and with /greet in a Session.",
    "engine": 1,
    "capabilities": ["routes"],
    "parts": {
      "server": "server.ts",
      "web": "web.tsx",
      "session": "session.ts"
    },
    "settings": {
      "greeting": { "type": "string", "title": "Greeting", "default": "Hello" }
    }
  }
}
```

Every part is optional. Write them in TypeScript or JavaScript. `version` is optional and shows on the Plugins page. The server bundles each one with its npm `dependencies`, so there's no build step of your own.

## The server part

The server part runs inside the server's process. Its default export is a `ServerPlugin` from `@pipoca/plugins`, with the plugin's id as its `name` and a `register` function that gets the plugin's context. Check the export with `satisfies`:

```ts
import { NotFound, type ServerPlugin } from "@pipoca/plugins";

export default {
  name: "greeter",
  register: (context) => {
    context.routes.handle((_request, path) => {
      if (path !== "greeting") {
        throw new NotFound(`the greeter has no ${path}`);
      }

      return Response.json({ greeting: context.settings.get()["greeting"] });
    });
  },
} satisfies ServerPlugin;
```

The server and Session parts import `@pipoca/plugins` from the server they run on, the way a web part gets React from the page, so don't list it in `dependencies`. It changes with the server, and `engine` says which version a plugin was written for ([ADR 0046](adr/0046-plugin-sdk-from-the-server.md)). A route throws `BadRequest(message)`, `NotFound(message)` or `HttpError(status, message)` to answer with that status and `{ "error": message }`, as the server does for its own routes. `readJson(request)` reads a JSON body or throws a `BadRequest`, and `fieldsOf(body)` gives a body's fields to check one by one.

`context.routes.handle` answers everything under `/api/plugins/greeter/`. The handler gets the request, the rest of the path, and its caller. The caller is `{ kind: "user", actor, admin }` for a signed-in user, also when a toolset tool sends the request for them (from a meta-session, `admin` is always false), and `{ kind: "session", session, actor }` when the plugin's Session part sent it. A route acts as its caller: a Session it starts for a user takes `actor: caller.actor`, so it gets that user's git logins. A route that changes config every user shares calls `requireAdmin(caller, message)` first, which answers 403 with the message unless `caller.kind === "user" && caller.admin` ([ADR 0038](adr/0038-single-sign-on-and-admins.md#admins)). The part can use only the context members its manifest lists in `capabilities`. Reaching for any other member fails the plugin when it registers. `owner`, `store`, `settings`, `config`, `changes`, `signal` and `log` are always there, and `auth` is only for built-in plugins. `context.store` is the plugin's own SQLite database, with `exec`, `all` and `run` for SQL and `seal` and `open` for secrets it keeps in a table. Name its tables `<id>_<table>`. `context.config.get()` is the plugin's key in the server's `pipoca.json`, read again when the file changes, `context.config.set(value)` replaces that key, and `context.config.dir` is a folder of the plugin's own next to it. The plugin decides whether its configuration lives there, in its store, or in both ([ADR 0039](adr/0039-plugin-config-files.md)). `context.changes.publish(name)` tells open pages that something of the plugin's changed; they hear the topic `<id>.<name>` ([ADR 0038](adr/0038-tool-repair-change-events-and-context.md)).

Name a route for the thing it serves and let the method say what happens to it: `GET` reads, `POST` adds or changes, and `DELETE` removes. The `oidc` plugin removes a provider with `DELETE providers/<id>`, not `POST providers/<id>/remove`. Encode a key that can hold `/` or spaces with `encodeURIComponent`, and decode it in the route, since the path arrives as the browser sent it.

| Capability     | What it gives                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------- |
| `routes`       | Answer HTTP requests under `/api/plugins/<id>/`, from browsers and from the plugin's Session part |
| `tools`        | Register tools that the Sessions you pick can call                                                |
| `toolsets`     | Register a meta toolset for the assistant and MCP clients ([ADR 0035](adr/0035-meta-sessions.md)) |
| `events`       | Listen to Session events and publish the plugin's own                                             |
| `sessions`     | Start, read, archive and message Sessions, and own the ones it starts                             |
| `environments` | List Environments, see Sessions waiting for a machine, and give runners it starts a token         |
| `profiles`     | Provide the Profiles its own Sessions start with                                                  |
| `models`       | Offer models to the model picker                                                                  |

## The web part

The web part's default export is a `WebPlugin`, the same object a built-in exports from `@pipoca/plugins/web`. `nav` adds a sidebar entry and its page:

```tsx
import type { PageProps, WebPlugin } from "@pipoca/plugins/web";
import { Button, PageTitle } from "@pipoca/ui";
import { useState } from "react";

function Page({ context }: PageProps) {
  const [greeting, setGreeting] = useState("");

  const greet = async () => {
    const response = await context.request("greeting");
    const body = (await response.json()) as { greeting: string };

    setGreeting(body.greeting);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8">
      <PageTitle description="An example plugin.">Greeter</PageTitle>
      <Button onClick={() => void greet()}>Greet me</Button>
      <p>{greeting}</p>
    </div>
  );
}

export default {
  name: "greeter",
  nav: { label: "Greeter", Page },
} satisfies WebPlugin;
```

`Page` gets `{ context, path }`, where `path` is the rest of the address after the plugin's page. `context.request(path, init)` is `fetch` for the plugin's own routes: `context.request("greeting")` asks `/api/plugins/greeter/greeting`, and `context.request("items", { method: "PUT", body })` sends any method and body. A path that starts with `/`, such as `/api/environments`, goes to the server's own API instead. `context.settings` holds the plugin's settings. `nav` can also list links under the entry with `Items`, and say with `fills` which paths fill the window.

The other slots are `SessionPanel`, `SessionHeader`, `EnvironmentSection`, `SettingsSection`, `Home`, `tools` and `widgets` for drawing tool calls and extension widgets, `notices`, `links`, `sessionPath` for where a Session the plugin owns opens, and `repositories` for the repositories New Session offers.

`useLoaded(load, key, { topics })` from `@pipoca/plugins/web` loads data and loads it again when one of the topics changes, such as `sessions`, `profiles`, `environments`, `plugins` or your own `<id>.<name>`. Pass `everyMs` instead for data that changes outside Pipoca.

The part shares `react`, `react-dom`, `@pipoca/ui` and `@pipoca/plugins/web` with the page, so hooks work and it looks like the rest of the app. It can't import CSS or other files yet. The page only has the Tailwind classes the app itself uses, so build the UI from `@pipoca/ui` components.

## The Session part

The Session part runs in every Session's process, on whichever machine runs it, including a laptop. Set `ownSessionsOnly` in the manifest to load it only in the Sessions your server part starts. Its default export is a `SessionPlugin`:

```ts
import type { SessionPlugin } from "@pipoca/plugins";

export default {
  name: "greeter",
  extension: (cloud) => (pi) => {
    pi.registerCommand("greet", {
      description: "Say the greeting from the Greeter plugin's settings",
      handler: async (_args, ctx) => {
        const response = await cloud.request("greeting");
        const { greeting } = (await response.json()) as { greeting: string };

        ctx.ui.notify(`${greeting} from ${ctx.cwd}`, "info");
      },
    });
  },
} satisfies SessionPlugin;
```

`extension` returns a Pi extension (Pi's `docs/extensions.md`). `cloud.request` calls the plugin's own routes on behalf of the Session, and `cloud.settings` holds its settings as they were when the Session started. `cloud.publish(key, data)` shares a value with everyone watching the Session, `cloud.checkouts` lists the git checkouts in its workspace, `cloud.askQuestions` asks the user questions, and `cloud.log` logs a message with fields. Instead of an extension, a part can list Pi `packages` to load, or return `tools`. A part can also return `logins`: a Pi `CredentialStore` for the Session's model logins and a store for its MCP sign-ins, kept instead of the runner's files, as the `logins` plugin does; the first part that returns them is used. Runners fetch the bundle by its hash when a Session starts. The part can't import files other than code.

## Install it

There are three ways to put a plugin on a server, and each one installs it turned off:

- **From git:** paste the repository's URL on the Plugins page. A branch, tag or commit after `#` pins it, for example `https://github.com/you/greeter.git#v1.0.0`. The plugin's `package.json` has to be at the top of the repository.
- **From a tarball:** paste a `.tgz` URL. It must hold one folder, as `npm pack` makes.
- **In place:** ask the Pipoca assistant to write one. It writes the files into the plugins folder and builds them, but it can't turn the plugin on.

You can also put the folder in the server's plugins folder yourself (`--plugins`, next to the database by default), or link it there from where you develop it.

Then select Turn on. The confirm lists the capabilities the plugin asks for and where its parts will run. Restart the server from the banner that appears. A plugin installed from git or a tarball can be updated to the newest version at its URL. A new version that asks for more capabilities, or adds a web or Session part, is turned off until you turn it on again.

## Test it

`@pipoca/plugins/testing` has what a test of a server part needs. `fakeContext(members)` returns a context with the members you pass, and the others throw when called. `owner`, `events`, `changes`, `store`, `settings`, `config`, `signal` and `log` work without passing them: the store is an SQLite database in memory from `memoryStore()`, and the settings are empty. `fakeUser({ id, admin })` is a signed-in user calling a route, not an admin unless you say, and `fakeSession(fields)` makes a Session for a Session caller. `served(route)` answers what the route throws as the server does.

```ts
import type { PluginRoute } from "@pipoca/plugins";
import { fakeContext, fakeUser } from "@pipoca/plugins/testing";
import greeter from "./server";

let route: PluginRoute | undefined;

greeter.register(
  fakeContext({
    routes: {
      handle: (handler) => {
        route = handler;
      },
    },
    settings: { get: () => ({ greeting: "Hi" }) },
  }),
);

const response = await route?.(
  new Request("http://greeter/greeting"),
  "greeting",
  fakeUser(),
);
```

## Know the limits

- A plugin runs with the server's own access. Capabilities catch mistakes but don't sandbox anything, so turn on only plugins you trust.
- The server installs dependencies with `bun install --ignore-scripts` and builds with Bun macros off. A plugin can't use `workspaces`, `patchedDependencies`, `workspace:` or `link:` dependencies, a dependency from a path outside its folder, a `bunfig.toml`, or an `.npmrc`.
- A fetched plugin can't contain symlinks, and a URL can't contain credentials. Use an ssh URL with a key for a private repository.
- `@pipoca/plugins` isn't on npm yet. A running part gets it from the server, but its types and `@pipoca/plugins/testing` come from a checkout of the Pipoca repository.
- Parts run from `.build` in the plugin's folder, so a part that reads files next to itself through `import.meta.url` should look one folder up.
- Settings types are `string`, `number` (with `min` and `max`), `boolean`, `choice` (with `options`) and `strings`. Each takes a `title`, an optional `description`, and a `default`.
