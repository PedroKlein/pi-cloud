import type { Log } from "@pi-cloud/providers";
import { Sessions, type SessionsOptions } from "@pi-cloud/sessions";
import web from "@pi-cloud/web/index.html";
import { createHandler } from "./server";
import { openStore } from "./store";
import { terminalBroker } from "./terminals";

export interface ServeOptions {
  readonly port: number;
  readonly database: string;
  readonly sessions?: SessionsOptions;
  readonly log: Log;
}

export function serve(options: ServeOptions): {
  readonly url: URL;
  readonly stop: () => Promise<void>;
} {
  const store = openStore(options.database);
  const sessions = new Sessions(store, options.sessions);
  const handler = createHandler(sessions, options.log);
  const terminals = terminalBroker(sessions, options.log);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    idleTimeout: 30,
    development: false,
    routes: { "/": web },
    fetch: async (request, bunServer) => {
      const upgraded = terminals.upgrade(request, bunServer);
      if (upgraded === "upgraded") {
        return undefined;
      }
      return upgraded ?? handler(request);
    },
    websocket: terminals.websocket,
  });
  options.log("server listening", { url: server.url.href });
  return {
    url: server.url,
    stop: async () => {
      await server.stop(true);
      sessions.close();
      store.close();
      options.log("server stopped");
    },
  };
}
