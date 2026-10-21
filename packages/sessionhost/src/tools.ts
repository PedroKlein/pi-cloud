import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ToolResult, ToolSpec } from "@pi-cloud/protocol";

export interface ServerToolCalls {
  readonly tools: readonly ToolDefinition[];
  readonly result: (id: string, result: ToolResult) => void;
  readonly cancelAll: () => void;
}

// Tools served by server plugins (ADR 0015): a call goes up the stream and
// its result comes back as a tool_result command.
export function serverTools(
  specs: readonly ToolSpec[],
  call: (id: string, name: string, input: unknown) => Promise<void>,
): ServerToolCalls {
  const pending = new Map<
    string,
    { resolve: (result: ToolResult) => void; reject: (error: Error) => void }
  >();

  const tools = specs.map((spec) =>
    defineTool({
      name: spec.name,
      label: spec.name,
      description: spec.description,
      parameters: Type.Unsafe<unknown>(spec.parameters),
      async execute(_toolCallId, input, signal) {
        const id = randomUUID();

        const result = await new Promise<ToolResult>((resolve, reject) => {
          pending.set(id, { resolve, reject });

          signal?.addEventListener("abort", () => {
            pending.delete(id);
            reject(new Error("tool call aborted"));
          });

          call(id, spec.name, input).catch((error: unknown) => {
            pending.delete(id);

            reject(
              new Error(
                `the server could not run ${spec.name}: ${String(error)}`,
              ),
            );
          });
        });

        if (result.isError) {
          throw new Error(result.text);
        }

        return {
          content: [{ type: "text", text: result.text }],
          details: {},
        };
      },
    }),
  );

  return {
    tools,
    result: (id, result) => {
      pending.get(id)?.resolve(result);
      pending.delete(id);
    },
    cancelAll: () => {
      for (const { reject } of pending.values()) {
        reject(new Error("session stopped"));
      }

      pending.clear();
    },
  };
}
