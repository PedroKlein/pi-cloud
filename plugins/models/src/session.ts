import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import type { SessionCloud, SessionPlugin } from "@pi-cloud/plugins";
import {
  type Alias,
  aliasesOf,
  candidates,
  failure,
  gatewayProvider,
  unhealthy,
} from "./gateway";
import { mergeHealth, type SessionConfig } from "./model";

const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const retryMs = 5000;

// Registers the Environment's aliases as Pi virtual models under the gateway
// provider. Each request goes to the first healthy backend in the chain, and
// a backend that fails is reported so every Session in the Environment stops
// using it.
export const models: SessionPlugin = {
  name: "models",
  extension: (cloud) => async (pi) => {
    const first = await read(cloud, undefined, undefined).catch(
      (error: unknown) => {
        cloud.log("model aliases not read", { error: String(error) });

        return undefined;
      },
    );

    if (first === undefined || first.aliases === null) {
      return;
    }

    let config = first;
    let registered: readonly Alias[] = [];

    const register = (): void => {
      const aliases = config.aliases ? aliasesOf(config.aliases) : [];

      for (const alias of registered) {
        if (!aliases.some(({ id }) => id === alias.id)) {
          pi.unregisterVirtualModel(gatewayProvider, alias.id);
        }
      }

      for (const alias of aliases) {
        try {
          pi.registerVirtualModel({
            provider: gatewayProvider,
            id: alias.id,
            name: alias.id,
            thinkingLevels,
            route: (request, ctx) => {
              const sticky = stickyOf(request);

              const now = new Date();
              if (
                sticky &&
                !unhealthy(config.health, sticky.model.provider, now) &&
                candidates(
                  config.aliases ?? { backends: {} },
                  config.health,
                  alias,
                  now,
                ).some(({ backend }) => backend === sticky.model.provider)
              ) {
                return {
                  model: sticky.model,
                  thinkingLevel: request.thinkingLevel,
                };
              }

              return {
                model: pick(config, alias, ctx, now),
                thinkingLevel: request.thinkingLevel,
              };
            },
          });
        } catch (error) {
          cloud.log("model alias not registered", {
            alias: alias.id,
            error: String(error),
          });
        }
      }

      registered = aliases;
    };

    register();

    const report = (backend: string, errorMessage: string): void => {
      const now = new Date();

      const entry = config.aliases
        ? failure(config.aliases, backend, errorMessage, now)
        : undefined;

      if (entry === undefined) {
        return;
      }

      const health = mergeHealth(
        config.health,
        { version: 1, unhealthyUntil: { [backend]: entry } },
        now,
      );

      config = { ...config, health };
      cloud.log("backend unhealthy", { backend, until: entry.until });

      void cloud
        .request("health", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(health),
        })
        .catch((error: unknown) => {
          cloud.log("backend health not reported", { error: String(error) });
        });
    };

    pi.on("message_end", (event, ctx) => {
      const { message } = event;
      if (
        message.role === "assistant" &&
        message.stopReason === "error" &&
        ctx.model?.provider === gatewayProvider
      ) {
        report(message.provider, message.errorMessage ?? "");
      }
    });

    follow(pi, cloud, config.version, (next) => {
      const aliasesChanged =
        JSON.stringify(next.aliases) !== JSON.stringify(config.aliases);

      config = next;
      if (aliasesChanged) {
        register();
      }
    });
  },
};

// Tool follow-ups and retries stay on the model that answered, which keeps
// the prompt cache, unless its backend has since become unhealthy.
function stickyOf(request: ModelRouteRequest): ModelRouteRequest["previous"] {
  switch (request.reason) {
    case "continuation":
      return request.previous;
    case "retry":
      return request.failed;
    case "user":
    case "direct":
      return undefined;
  }
}

function pick(
  config: SessionConfig,
  alias: Alias,
  ctx: ExtensionContext,
  now: Date,
): NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>> {
  for (const { backend, modelId } of candidates(
    config.aliases ?? { backends: {} },
    config.health,
    alias,
    now,
  )) {
    const model = ctx.modelRegistry.find(backend, modelId);
    if (model && ctx.modelRegistry.hasConfiguredAuth(model)) {
      return model;
    }
  }

  throw new Error(
    `no healthy backend with a signed-in model for ${gatewayProvider}/${alias.id}`,
  );
}

async function read(
  cloud: SessionCloud,
  after: number | undefined,
  signal: AbortSignal | undefined,
): Promise<SessionConfig> {
  const path = after === undefined ? "config" : `config?after=${String(after)}`;
  const response = await cloud.request(path, signal ? { signal } : {});
  if (!response.ok) {
    throw new Error(`models answered ${String(response.status)}`);
  }

  return (await response.json()) as SessionConfig;
}

// Waits for the server's next change to the config or health, until the
// Session shuts down.
function follow(
  pi: ExtensionAPI,
  cloud: SessionCloud,
  version: number,
  changed: (config: SessionConfig) => void,
): void {
  const stop = new AbortController();
  const stopped = (): boolean => stop.signal.aborted;

  pi.on("session_shutdown", () => {
    stop.abort();
  });

  void (async () => {
    let seen = version;
    while (!stop.signal.aborted) {
      try {
        const next = await read(cloud, seen, stop.signal);
        if (next.version !== seen) {
          seen = next.version;
          changed(next);
        }
      } catch (error) {
        if (stopped()) {
          return;
        }

        cloud.log("model aliases not followed", { error: String(error) });
        await new Promise((resolve) => setTimeout(resolve, retryMs));
      }
    }
  })();
}
