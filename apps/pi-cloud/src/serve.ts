import type { Log } from "@pi-cloud/providers";
import { Sessions, type SessionsOptions } from "@pi-cloud/sessions";
import { createHandler } from "./server";
import { openStore } from "./store";

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
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    idleTimeout: 30,
    fetch: createHandler(sessions, options.log),
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
