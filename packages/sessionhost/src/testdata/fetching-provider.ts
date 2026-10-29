import { writeFile } from "node:fs/promises";
import { join } from "node:path";

// An extension whose provider lists its models from the network with the
// stored login, like SAP AI Core's.
export async function fetchingProviderExtension(dir: string): Promise<string> {
  const extension = join(dir, "vault.ts");

  await writeFile(
    extension,
    `import { createProvider, envApiKeyAuth, openAICompletionsApi } from "@earendil-works/pi-ai";

export default (pi) => {
  pi.registerProvider(
    createProvider({
      id: "vault",
      name: "Vault",
      auth: { apiKey: envApiKeyAuth("Vault API key", []) },
      models: [],
      api: openAICompletionsApi(),
      fetchModels: async ({ allowNetwork, credential }) =>
        allowNetwork && credential?.key === "vault-key"
          ? [{
              id: "vault-large",
              name: "vault-large",
              provider: "vault",
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:9/v1",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1000,
              maxTokens: 100,
            }]
          : [],
    }),
  );
};
`,
  );

  return extension;
}
