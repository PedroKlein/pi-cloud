import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { startSession } from "../session";
import { fauxModels } from "./models";
import { sessionOptions } from "./options";

const [root] = process.argv.slice(2);
if (root === undefined) {
  throw new Error("usage: crashing-session <root>");
}

const { faux, models } = await fauxModels(root);

faux.setResponses([
  fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 10" })], {
    stopReason: "toolUse",
  }),
]);

const session = await startSession(sessionOptions(root, { models }));

session.subscribe((event) => {
  if (event.type === "tool_execution_start") {
    process.stdout.write("tool started\n");
  }
});

await session.prompt("run something slow");
