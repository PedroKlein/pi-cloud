import type { Log } from "@pi-cloud/providers";
import { Sessions } from "@pi-cloud/sessions";
import { createHandler } from "./server";
import { openStore } from "./store";

export interface ServeOptions {
  readonly port: number;
  readonly database: string;
  readonly log: Log;
}

export function serve(options: ServeOptions): {
  readonly url: URL;
  readonly stop: () => Promise<void>;
} {
  const store = openStore(options.database);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    idleTimeout: 30,
    fetch: createHandler(new Sessions(store), options.log),
  });
  options.log("server listening", { url: server.url.href });
  return {
    url: server.url,
    stop: async () => {
      await server.stop(true);
      store.close();
      options.log("server stopped");
    },
  };
}
