import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { startSession, stopSession } from "../session";
import { fauxModels } from "./models";
import { sessionOptions } from "./options";

const [root, ...extensionPaths] = process.argv.slice(2);
if (root === undefined) {
  throw new Error("usage: compiled-session <root> [extension...]");
}

const { faux, models } = await fauxModels(root);

faux.setResponses([
  fauxAssistantMessage([fauxToolCall("codemode", { code: "return 6 * 7" })], {
    stopReason: "toolUse",
  }),
  fauxAssistantMessage([fauxText("compiled ok")]),
]);

const session = await startSession(
  sessionOptions(root, { extensionPaths, models }),
);

const toolOutputs: string[] = [];

session.subscribe((event) => {
  if (event.type === "tool_execution_end") {
    toolOutputs.push(JSON.stringify(event.result));
  }
});

await session.prompt("hello");
await stopSession(session);

process.stdout.write(
  JSON.stringify({
    tools: session.getActiveToolNames(),
    reply: session.getLastAssistantText(),
    toolOutputs,
  }),
);
