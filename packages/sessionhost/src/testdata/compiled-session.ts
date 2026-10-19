import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { startSession, stopSession } from "../index";

const [root, ...extensionPaths] = process.argv.slice(2);
if (root === undefined) {
  throw new Error("usage: compiled-session <root> [extension...]");
}

const faux = fauxProvider();
faux.setResponses([fauxAssistantMessage([fauxText("compiled ok")])]);
const runtime = await ModelRuntime.create({
  authPath: join(root, "auth.json"),
  modelsPath: null,
  allowModelNetwork: false,
});
runtime.registerNativeProvider(faux.provider);

const session = await startSession({
  cwd: root,
  agentDir: join(root, "agent"),
  sessionDir: join(root, "sessions"),
  extensionPaths,
  models: { runtime, model: faux.getModel() },
});
await session.prompt("hello");
await stopSession(session);
process.stdout.write(
  JSON.stringify({
    tools: session.getActiveToolNames(),
    reply: session.getLastAssistantText(),
  }),
);
