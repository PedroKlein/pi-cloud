import type { LiveEvent, Session, SessionEvent } from "@pi-cloud/protocol";
import { chatItems, type ChatItem } from "./chat";
import { renderPrompt } from "./prompt";
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

let selected: string | undefined;
let closeEvents = (): void => undefined;
let closeTerminal: (() => void) | undefined;

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

async function refreshSessions(): Promise<void> {
  const sessions = (await (await api("/api/sessions")).json()) as Session[];
  sessionList.replaceChildren(
    ...sessions.toReversed().map((session) => {
      const item = document.createElement("li");
      item.setAttribute("aria-current", String(session.id === selected));
      const name = document.createElement("span");
      name.textContent = session.cwd;
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

function addItem(item: ChatItem): HTMLLIElement {
  const entry = document.createElement("li");
  entry.dataset["role"] = item.role;
  entry.textContent = item.text;
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
  chat.append(entry);
  if (atBottom) {
    chat.scrollTop = chat.scrollHeight;
  }
  return entry;
}

function follow(sessionId: string): () => void {
  let lines = 0;
  let streaming: HTMLLIElement | undefined;
  const tools = new Map<string, HTMLLIElement>();
  const prompts = new Map<string, HTMLElement>();
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
      case "text":
        streaming ??= addItem({ role: "assistant", text: "" });
        streaming.textContent += event.delta;
        return;
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
        const box = renderPrompt(event.prompt, (value) => {
          api(`/api/sessions/${sessionId}/commands`, {
            type: "answer",
            id,
            value,
          }).catch(report);
        });
        prompts.set(id, box);
        chat.append(box);
        chat.scrollTop = chat.scrollHeight;
        return;
      }
      case "prompt_end":
        prompts.get(event.id)?.remove();
        prompts.delete(event.id);
        return;
      case "notify":
        addItem({
          role: event.level === "error" ? "error" : "tool",
          text: event.message,
        });
        return;
    }
  };
  const events = new EventSource(`/api/sessions/${sessionId}/events`);
  events.addEventListener("open", () => {
    prompts.forEach((prompt) => {
      prompt.remove();
    });
    prompts.clear();
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
  };
}

function toggleTerminal(): void {
  if (closeTerminal) {
    closeTerminal();
    closeTerminal = undefined;
    terminalBox.hidden = true;
    return;
  }
  if (selected === undefined) {
    return;
  }
  terminalBox.hidden = false;
  closeTerminal = openTerminal(selected, terminalBox);
}

function select(sessionId: string | undefined): void {
  closeEvents();
  closeTerminal?.();
  closeTerminal = undefined;
  terminalBox.hidden = true;
  terminalBox.replaceChildren();
  chat.replaceChildren();
  selected = sessionId;
  panel.hidden = sessionId === undefined;
  if (sessionId !== undefined) {
    title.textContent = sessionId;
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
  api("/api/sessions", {
    provider: form.get("provider"),
    cwd: form.get("cwd"),
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
  const field = promptForm.elements.namedItem("text") as HTMLTextAreaElement;
  const text = field.value.trim();
  if (selected === undefined || text === "") {
    return;
  }
  field.value = "";
  api(`/api/sessions/${selected}/commands`, { type: "message", text }).catch(
    report,
  );
});

promptForm.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    promptForm.requestSubmit();
  }
});

abortButton.addEventListener("click", () => {
  if (selected !== undefined) {
    api(`/api/sessions/${selected}/commands`, { type: "abort" }).catch(report);
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
