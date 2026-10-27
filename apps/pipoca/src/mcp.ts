import type { Log } from "@pipoca/providers";
import type { Auth } from "./auth";
import type { PluginHost } from "./plugins";

// Pipoca's meta toolsets over MCP's streamable HTTP transport (ADR 0035):
// one JSON reply per request and no server-sent stream, which the transport
// allows. A client authenticates with an MCP token and acts as its user.
// https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
const protocolVersions = ["2025-06-18", "2025-03-26", "2024-11-05"];

type Id = string | number;

interface Message {
  readonly id?: Id;
  readonly method?: unknown;
  readonly params?: unknown;
}

export function mcpHandler(
  auth: Auth,
  plugins: PluginHost,
  serverVersion: string,
  log: Log,
): (request: Request) => Promise<Response> {
  const answer = async (
    { method, params }: Message,
    userId: string,
  ): Promise<unknown> => {
    switch (method) {
      case "initialize": {
        const asked = fieldsOf(params)["protocolVersion"];

        return {
          protocolVersion:
            typeof asked === "string" && protocolVersions.includes(asked)
              ? asked
              : protocolVersions[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "pipoca", version: serverVersion },
        };
      }

      case "ping":
        return {};

      case "tools/list":
        return {
          tools: plugins
            .toolsetTools()
            .map(({ name, description, parameters, annotations }) => ({
              name,
              description,
              inputSchema: parameters,
              ...(annotations && { annotations }),
            })),
        };

      case "tools/call": {
        const { name, arguments: input } = fieldsOf(params);
        if (typeof name !== "string") {
          throw new RpcError(-32602, "params.name must be a tool name");
        }

        const result = await plugins.callToolset(
          name,
          input ?? {},
          `user:${userId}`,
        );

        log("mcp tool called", { tool: name, isError: result.isError });

        return {
          content: [{ type: "text", text: result.text }],
          isError: result.isError,
        };
      }

      default:
        throw new RpcError(-32601, `no method ${String(method)}`);
    }
  };

  return async (request) => {
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }

    // Browsers send Origin, and a page on another site must not reach the
    // endpoint, as the transport asks.
    const origin = request.headers.get("origin");
    if (origin !== null && !sameHost(origin, request.url)) {
      return Response.json({ error: "foreign_origin" }, { status: 403 });
    }

    const user = auth.mcpUserOf(request);
    if (user === undefined) {
      return Response.json(
        { error: "unknown_token" },
        { status: 401, headers: { "www-authenticate": "Bearer" } },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return rpcError(null, -32700, "the body isn't JSON");
    }

    if (Array.isArray(body)) {
      return rpcError(null, -32600, "batches aren't supported");
    }

    const message: Message = fieldsOf(body);

    // Notifications and responses from the client need no answer.
    if (message.id === undefined) {
      return new Response(null, { status: 202 });
    }

    if (typeof message.method !== "string") {
      return rpcError(message.id, -32600, "a request needs a method");
    }

    try {
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: await answer(message, user.id),
      });
    } catch (error) {
      if (error instanceof RpcError) {
        return rpcError(message.id, error.code, error.message);
      }

      throw error;
    }
  };
}

class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function rpcError(id: Id | null, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

function fieldsOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sameHost(origin: string, url: string): boolean {
  try {
    return new URL(origin).host === new URL(url).host;
  } catch {
    return false;
  }
}
