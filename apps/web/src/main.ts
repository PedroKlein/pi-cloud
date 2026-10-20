import type {
  Command,
  LiveEvent,
  Session,
  SessionEvent,
  Workspace,
} from "@pi-cloud/protocol";
import { chatItems, type ChatItem } from "./chat";
import { renderPrompt, type RenderedPrompt } from "./prompt";
import { openTerminal } from "./terminal";

const sessionsRefreshMs = 2000;

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) {
    throw new Error(`missing #${id}`);
  }

  return found;
}

const createForm = element("create", HTMLFormElement);
const sessionList = element("sessions", HTMLUListElement);
const panel = element("session", HTMLElement);
const title = element("title", HTMLElement);
const statusLabel = element("status", HTMLElement);
const chat = element("chat", HTMLOListElement);
const terminalBox = element("terminal", HTMLElement);
const terminalButton = element("open-terminal", HTMLButtonElement);
const abortButton = element("abort", HTMLButtonElement);
const promptForm = element("prompt", HTMLFormElement);
const promptText = element("prompt-text", HTMLTextAreaElement);
const widgetsAbove = element("widgets-above", HTMLElement);
const widgetsBelow = element("widgets-below", HTMLElement);
const extensionStatus = element("extension-status", HTMLElement);

let selected: string | undefined;
let closeEvents = (): void => undefined;
let closeTerminal: (() => void) | undefined;
let terminalLive = false;

async function api(path: string, body?: unknown): Promise<Response> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    ...(body !== undefined && {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });

  if (!response.ok) {
    const { error } = (await response.json()) as { error: string };
    throw new Error(error);
  }

  return response;
}

function describe(session: Session): string {
  const where = session.online ? "" : ", provider offline";

  return `${session.status}${where}${session.error === null ? "" : `: ${session.error}`}`;
}

function workspaceName(workspace: Workspace): string {
  return workspace.kind === "folder"
    ? workspace.path
    : `${workspace.repository} (${workspace.branch})`;
}

async function refreshSessions(): Promise<void> {
  const sessions = (await (await api("/api/sessions")).json()) as Session[];

  sessionList.replaceChildren(
    ...sessions.toReversed().map((session) => {
      const item = document.createElement("li");
      item.setAttribute("aria-current", String(session.id === selected));
      const name = document.createElement("span");
      name.textContent = workspaceName(session.workspace);
      const details = document.createElement("small");
      details.textContent = `${session.provider} · ${describe(session)}`;
      item.append(name, details);

      item.addEventListener("click", () => {
        location.hash = session.id;
      });

      return item;
    }),
  );
}

function keepScrolled(change: () => void): void {
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
  change();
  if (atBottom) {
    chat.scrollTop = chat.scrollHeight;
  }
}

function addItem(item: ChatItem): HTMLLIElement {
  const entry = document.createElement("li");
  entry.dataset["role"] = item.role;
  entry.textContent = item.text;

  keepScrolled(() => {
    chat.append(entry);
  });

  return entry;
}

function follow(sessionId: string): () => void {
  let lines = 0;
  let streaming: HTMLLIElement | undefined;
  const tools = new Map<string, HTMLLIElement>();
  const prompts = new Map<string, RenderedPrompt>();
  const statuses = new Map<string, string>();
  const widgets = new Map<string, Extract<LiveEvent, { type: "widget" }>>();

  const renderSurfaces = (): void => {
    extensionStatus.textContent = [...statuses.values()].join(" · ");

    const widgetText = (placement: string): string =>
      [...widgets.values()]
        .filter((widget) => widget.placement === placement)
        .flatMap((widget) => widget.lines ?? [])
        .join("\n");

    widgetsAbove.textContent = widgetText("aboveEditor");
    widgetsBelow.textContent = widgetText("belowEditor");
  };

  const clearSurfaces = (): void => {
    statuses.clear();
    widgets.clear();
    renderSurfaces();
  };

  const clearLive = (): void => {
    streaming?.remove();
    streaming = undefined;

    tools.forEach((tool) => {
      tool.remove();
    });

    tools.clear();
  };

  const live = (event: LiveEvent): void => {
    switch (event.type) {
      case "status":
        if (event.status === "idle") {
          clearLive();
        }

        return;
      case "text": {
        streaming ??= addItem({ role: "assistant", text: "" });
        const bubble = streaming;

        keepScrolled(() => {
          bubble.textContent += event.delta;
        });

        return;
      }

      case "tool_start":
        tools.set(
          event.toolCallId,
          addItem({ role: "tool", text: `${event.toolName} running…` }),
        );

        return;
      case "tool_end":
        tools.get(event.toolCallId)?.remove();
        tools.delete(event.toolCallId);

        return;
      case "prompt": {
        const { id } = event.prompt;
        if (prompts.has(id)) {
          return;
        }

        const command = (body: Command): void => {
          api(
            `/api/sessions/${encodeURIComponent(sessionId)}/commands`,
            body,
          ).catch(report);
        };

        const rendered = renderPrompt(
          event.prompt,
          (value) => {
            command({ type: "answer", id, value });
          },
          (questionId, value, question) => {
            command({ type: "explain", id, questionId, value, question });
          },
        );

        prompts.set(id, rendered);
        chat.append(rendered.element);
        chat.scrollTop = chat.scrollHeight;

        return;
      }

      case "prompt_end":
        prompts.get(event.id)?.element.remove();
        prompts.delete(event.id);

        return;
      case "explanation":
        prompts.get(event.id)?.explained(event);

        return;
      case "notify":
        addItem({
          role: event.level === "error" ? "error" : "tool",
          text: event.message,
        });

        return;
      case "extension_status":
        if (event.text === null) {
          statuses.delete(event.key);
        } else {
          statuses.set(event.key, event.text);
        }

        renderSurfaces();

        return;
      case "widget":
        if (event.lines === null) {
          widgets.delete(event.key);
        } else {
          widgets.set(event.key, event);
        }

        renderSurfaces();

        return;
      case "title":
        title.textContent = event.title;
        document.title = `${event.title} · Pi Cloud`;

        return;
      case "editor_text":
        promptText.value = event.text;
        promptText.focus();

        return;
    }
  };

  const events = new EventSource(
    `/api/sessions/${encodeURIComponent(sessionId)}/events`,
  );

  events.addEventListener("error", () => {
    if (events.readyState === EventSource.CLOSED) {
      statusLabel.textContent = "session not found";
    }
  });

  events.addEventListener("open", () => {
    prompts.forEach((prompt) => {
      prompt.element.remove();
    });

    prompts.clear();
    clearSurfaces();
  });

  events.addEventListener("message", (message: MessageEvent<string>) => {
    const event = JSON.parse(message.data) as SessionEvent;
    switch (event.type) {
      case "session":
        statusLabel.textContent = describe(event.session);
        refreshSessions().catch(() => undefined);

        return;
      case "entry":
        if (event.line < lines) {
          return;
        }

        lines = event.line + 1;
        clearLive();
        chatItems(event.entry).forEach(addItem);

        return;
      case "live":
        live(event.event);

        return;
    }
  });

  return () => {
    events.close();
    clearSurfaces();
  };
}

function toggleTerminal(): void {
  const wasLive = terminalLive;
  closeTerminal?.();
  closeTerminal = undefined;
  terminalLive = false;
  terminalBox.replaceChildren();
  terminalBox.hidden = wasLive || selected === undefined;
  if (terminalBox.hidden || selected === undefined) {
    return;
  }

  terminalLive = true;

  closeTerminal = openTerminal(selected, terminalBox, () => {
    terminalLive = false;
  });
}

function select(sessionId: string | undefined): void {
  closeEvents();
  closeTerminal?.();
  closeTerminal = undefined;
  terminalLive = false;
  terminalBox.hidden = true;
  terminalBox.replaceChildren();
  chat.replaceChildren();
  selected = sessionId;
  panel.hidden = sessionId === undefined;
  if (sessionId !== undefined) {
    title.textContent = sessionId;
    document.title = "Pi Cloud";
    statusLabel.textContent = "";
    closeEvents = follow(sessionId);
  }

  refreshSessions().catch(() => undefined);
}

function report(error: unknown): void {
  addItem({ role: "error", text: String(error) });
}

createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(createForm);

  const where = form.get("location");

  api("/api/sessions", {
    provider: form.get("provider"),
    workspace:
      form.get("kind") === "clone"
        ? { kind: "clone", repository: where }
        : { kind: "folder", path: where },
  })
    .then(async (response) => {
      location.hash = ((await response.json()) as Session).id;
    })
    .catch((error: unknown) => {
      alert(String(error));
    });
});

promptForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = promptText.value.trim();
  if (selected === undefined || text === "") {
    return;
  }

  promptText.value = "";

  api(`/api/sessions/${encodeURIComponent(selected)}/commands`, {
    type: "message",
    text,
    requestId: crypto.randomUUID(),
  }).catch(report);
});

promptForm.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    promptForm.requestSubmit();
  }
});

abortButton.addEventListener("click", () => {
  if (selected !== undefined) {
    api(`/api/sessions/${encodeURIComponent(selected)}/commands`, {
      type: "abort",
    }).catch(report);
  }
});

terminalButton.addEventListener("click", toggleTerminal);

window.addEventListener("hashchange", () => {
  select(location.hash.slice(1) || undefined);
});

select(location.hash.slice(1) || undefined);

setInterval(() => {
  refreshSessions().catch(() => undefined);
}, sessionsRefreshMs);
