import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionOptions } from "../session";

export async function fauxModels(dir: string): Promise<{
  faux: ReturnType<typeof fauxProvider>;
  models: NonNullable<SessionOptions["models"]>;
}> {
  const faux = fauxProvider();
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  return { faux, models: { runtime, model: faux.getModel() } };
}
