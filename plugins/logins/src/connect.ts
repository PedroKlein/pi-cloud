import type {
  AuthInteraction,
  AuthPrompt,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Connection, ConnectionPrompt } from "./model";

// A sign-in nobody finishes stops holding its prompt and callback port.
const connectionMs = 10 * 60_000;

export interface Connections {
  readonly current: (userId: string) => Connection | undefined;
  // Starts the person's sign-in, in place of one still running.
  readonly start: (
    userId: string,
    provider: Pick<Connection, "provider" | "name" | "type">,
    credentials: CredentialStore,
  ) => void;
  // Says false when the prompt was already answered or taken back.
  readonly answer: (userId: string, prompt: string, answer: string) => boolean;
  // Stops a running sign-in, or forgets a finished one.
  readonly dismiss: (userId: string) => void;
}

interface Running {
  readonly abort: AbortController;
  view: Connection;
  asked:
    | {
        readonly prompt: ConnectionPrompt;
        readonly answer: (answer: string) => void;
      }
    | undefined;
}

// Pi's own login flows, run on the server for the person's Settings page
// (ADR 0045). Each change is published so the page shows the next step: a
// link to open, a device code or a prompt to answer.
export function connections(
  publish: () => void,
  log: (message: string, fields: Record<string, unknown>) => void,
): Connections {
  const running = new Map<string, Running>();
  let prompts = 0;

  const update = (entry: Running, view: Partial<Connection>): void => {
    entry.view = { ...entry.view, ...view };
    publish();
  };

  const ask = (entry: Running, asked: Running["asked"]): void => {
    entry.asked = asked;
    const { prompt: _, ...rest } = entry.view;

    update(
      entry,
      asked === undefined ? rest : { ...rest, prompt: asked.prompt },
    );
  };

  const dismiss = (userId: string): void => {
    const entry = running.get(userId);
    if (entry === undefined) {
      return;
    }

    running.delete(userId);
    entry.abort.abort(new Error("Login cancelled"));
    publish();
  };

  const interaction = (entry: Running): AuthInteraction => ({
    signal: entry.abort.signal,
    notify: (event) => {
      update(entry, { events: [...entry.view.events, event] });
    },
    prompt: async (prompt) =>
      new Promise<string>((resolve, reject) => {
        const asked = promptOf(String(++prompts), prompt);

        const withdraw = (): void => {
          if (entry.asked?.prompt === asked) {
            ask(entry, undefined);
          }

          reject(new Error("Login cancelled"));
        };

        prompt.signal?.addEventListener("abort", withdraw, { once: true });
        entry.abort.signal.addEventListener("abort", withdraw, { once: true });

        ask(entry, {
          prompt: asked,
          answer: (answer) => {
            ask(entry, undefined);
            resolve(answer);
          },
        });
      }),
  });

  const run = async (
    userId: string,
    entry: Running,
    credentials: CredentialStore,
  ): Promise<void> => {
    const { provider, type } = entry.view;

    try {
      const runtime = await ModelRuntime.create({
        credentials,
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
      });

      await runtime.login(provider, type, interaction(entry), {
        agentName: "Pipoca",
      });

      log("login connected", { userId, provider, type });
      ask(entry, undefined);
      update(entry, { state: "done" });
    } catch (error) {
      if (running.get(userId) !== entry) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      log("login not connected", { userId, provider, type, error: message });
      ask(entry, undefined);
      update(entry, { state: "failed", error: message });
    } finally {
      entry.abort.abort();
    }
  };

  return {
    current: (userId) => running.get(userId)?.view,
    start: (userId, { provider, name, type }, credentials) => {
      dismiss(userId);

      const entry: Running = {
        abort: new AbortController(),
        view: { provider, name, type, state: "running", events: [] },
        asked: undefined,
      };

      running.set(userId, entry);
      log("login started", { userId, provider, type });

      const timer = setTimeout(() => {
        entry.abort.abort(new Error("The sign-in took too long"));
      }, connectionMs);

      void run(userId, entry, credentials).finally(() => {
        clearTimeout(timer);
      });
    },
    answer: (userId, prompt, answer) => {
      const asked = running.get(userId)?.asked;
      if (asked?.prompt.id !== prompt) {
        return false;
      }

      asked.answer(answer);

      return true;
    },
    dismiss,
  };
}

function promptOf(id: string, prompt: AuthPrompt): ConnectionPrompt {
  return prompt.type === "select"
    ? {
        id,
        type: prompt.type,
        message: prompt.message,
        options: prompt.options.map(({ id: option, label }) => ({
          id: option,
          label,
        })),
      }
    : {
        id,
        type: prompt.type,
        message: prompt.message,
        ...(prompt.placeholder !== undefined && {
          placeholder: prompt.placeholder,
        }),
      };
}
