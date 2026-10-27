import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentOptions } from "./agent";

// Tests of the built binary, as on kind, run Sessions without a model
// provider: every turn answers with the same text.
export async function fauxModels(
  reply: string,
  authPath: string,
): Promise<NonNullable<AgentOptions["models"]>> {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });

  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath: null,
    allowModelNetwork: false,
  });

  runtime.registerNativeProvider(faux.provider);

  const answer = (): AssistantMessage => {
    faux.appendResponses([answer]);

    return fauxAssistantMessage([fauxText(reply)]);
  };

  faux.setResponses([answer]);

  return { runtime, model: faux.getModel() };
}
