import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRoute,
  ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import type { SessionCloud, SessionPlugin } from "@pipoca/plugins";
import { aliasesOf, candidates, failure, gatewayProvider } from "./gateway";
import { mergeHealth, type ModelRef, type SessionConfig } from "./model";

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
// provider. Each request goes to the alias's first healthy model, and a model
// or provider that fails is reported so every Session in the Environment
// stops using it.
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
    let registered: readonly string[] = [];

    const register = (): void => {
      const aliases = config.aliases ? aliasesOf(config.aliases) : [];

      for (const alias of registered) {
        if (!aliases.includes(alias)) {
          pi.unregisterVirtualModel(gatewayProvider, alias);
        }
      }

      for (const alias of aliases) {
        try {
          pi.registerVirtualModel({
            provider: gatewayProvider,
            id: alias,
            name: alias,
            thinkingLevels,
            route: (request, ctx) => ({
              model: routeModel(config, alias, request, ctx),
              thinkingLevel: request.thinkingLevel,
            }),
          });
        } catch (error) {
          cloud.log("model alias not registered", {
            alias,
            error: String(error),
          });
        }
      }

      registered = aliases;
    };

    register();

    const report = (model: ModelRef, errorMessage: string): void => {
      const now = new Date();

      const failed = config.aliases
        ? failure(config.aliases, model, errorMessage, now)
        : undefined;

      if (failed === undefined) {
        return;
      }

      const { key, entry } = failed;

      const health = mergeHealth(
        config.health,
        { version: 1, unhealthyUntil: { [key]: entry } },
        now,
      );

      config = { ...config, health };
      cloud.log("model unhealthy", { model: key, until: entry.until });

      void cloud
        .request("health", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(health),
        })
        .catch((error: unknown) => {
          cloud.log("model health not reported", { error: String(error) });
        });
    };

    pi.on("message_end", (event, ctx) => {
      const { message } = event;
      if (
        message.role === "assistant" &&
        message.stopReason === "error" &&
        ctx.model?.provider === gatewayProvider
      ) {
        report(
          { provider: message.provider, id: message.model },
          message.errorMessage ?? "",
        );
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
// the prompt cache, unless that model has since become unhealthy.
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

function routeModel(
  config: SessionConfig,
  alias: string,
  request: ModelRouteRequest,
  ctx: ExtensionContext,
): ModelRoute["model"] {
  const routable = candidates(
    config.aliases ?? { models: {} },
    config.health,
    alias,
    new Date(),
  );

  const sticky = stickyOf(request);
  if (
    sticky &&
    routable.some(
      ({ provider, id }) =>
        provider === sticky.model.provider && id === sticky.model.id,
    )
  ) {
    return sticky.model;
  }

  for (const { provider, id } of routable) {
    const model = ctx.modelRegistry.find(provider, id);
    if (model && ctx.modelRegistry.hasConfiguredAuth(model)) {
      return model;
    }
  }

  throw new Error(
    `no healthy, signed-in model for ${gatewayProvider}/${alias}`,
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
