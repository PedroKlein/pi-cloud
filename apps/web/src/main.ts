import type {
  Command,
  LiveEvent,
  ModelRef,
  Environment,
  Session,
  SessionEvent,
  Workspace,
} from "@pi-cloud/protocol";
import { chatItems, type ChatItem } from "./chat";
import { renderPrompt, type RenderedPrompt } from "./prompt";
import { openTerminal } from "./terminal";
import { addUsage, describeUsage, type Usage } from "./usage";

const sessionsRefreshMs = 2000;

// The server adds the actor to everything a browser sends.
type BrowserCommand = Command extends infer C
  ? C extends Command
    ? Omit<C, "actor">
    : never
  : never;

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) {
    throw new Error(`missing #${id}`);
  }

  return found;
}

const createForm = element("create", HTMLFormElement);
const environmentList = element("environments", HTMLSelectElement);
const folderList = element("folders", HTMLDataListElement);
const modelList = element("models", HTMLDataListElement);
const sessionList = element("sessions", HTMLUListElement);
const panel = element("session", HTMLElement);
const title = element("title", HTMLElement);
const statusLabel = element("status", HTMLElement);
const changesPanel = element("changes", HTMLDetailsElement);
const changesSummary = element("changes-summary", HTMLElement);
const changesStat = element("changes-stat", HTMLElement);
const changesPatch = element("changes-patch", HTMLElement);
const usageLabel = element("usage", HTMLElement);
const chat = element("chat", HTMLOListElement);
const terminalBox = element("terminal", HTMLElement);
const terminalButton = element("open-terminal", HTMLButtonElement);
const abortButton = element("abort", HTMLButtonElement);
const archiveButton = element("archive", HTMLButtonElement);
const unarchiveButton = element("unarchive", HTMLButtonElement);
const removeButton = element("remove-workspace", HTMLButtonElement);
const showArchived = element("show-archived", HTMLInputElement);
const promptForm = element("prompt", HTMLFormElement);
const promptText = element("prompt-text", HTMLTextAreaElement);
const queued = element("queued", HTMLElement);
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

const removalText = {
  pending: "removing workspace",
  forced: "deleting workspace",
  removed: "workspace removed",
  kept: "unpushed work",
} as const;

function describe(session: Session): string {
  if (session.archivedAt !== null) {
    return session.workspaceRemoval === null
      ? "archived"
      : `archived, ${removalText[session.workspaceRemoval]}`;
  }

  const where = session.online ? "" : ", provider offline";

  return `${session.status}${where}${session.error === null ? "" : `: ${session.error}`}`;
}

function workspaceName(workspace: Workspace): string {
  switch (workspace.kind) {
    case "folder":
      return workspace.path;
    case "worktree":
      return `${workspace.path} (${workspace.branch})`;
    case "clone":
      return `${workspace.repository} (${workspace.branch})`;
  }
}

function modelName({ provider, id }: ModelRef): string {
  return `${provider}/${id}`;
}

function modelRef(name: string): ModelRef | undefined {
  const slash = name.indexOf("/");

  return slash > 0 && slash < name.length - 1
    ? { provider: name.slice(0, slash), id: name.slice(slash + 1) }
    : undefined;
}

let environments: readonly Environment[] = [];

function option(value: string, label: string): HTMLOptionElement {
  const item = document.createElement("option");
  item.value = value;
  item.label = label;

  return item;
}

function renderEnvironments(): void {
  const form = new FormData(createForm);
  const previous = environmentList.value;

  environmentList.replaceChildren(
    ...environments.map((e) =>
      option(
        e.id,
        `${e.name} (${e.provider}, ${e.online ? "online" : "offline"})`,
      ),
    ),
  );

  if (environments.some((e) => e.id === previous)) {
    environmentList.value = previous;
  }

  const chosen = environments.find((e) => e.id === environmentList.value);

  folderList.replaceChildren(
    ...(form.get("kind") === "clone" ? [] : (chosen?.folders ?? [])).map(
      (folder) => option(folder, folder),
    ),
  );

  modelList.replaceChildren(
    ...(chosen?.models ?? []).map((model) =>
      option(modelName(model), modelName(model)),
    ),
  );
}

async function refreshEnvironments(): Promise<void> {
  environments = (await (
    await api("/api/environments")
  ).json()) as Environment[];

  renderEnvironments();
}

async function refreshSessions(): Promise<void> {
  const sessions = (await (
    await api(`/api/sessions?archived=${String(showArchived.checked)}`)
  ).json()) as Session[];

  sessionList.replaceChildren(
    ...sessions.toReversed().map((session) => {
      const item = document.createElement("li");
      item.dataset["id"] = session.id;
      item.setAttribute("aria-current", String(session.id === selected));
      const name = document.createElement("span");
      name.textContent = workspaceName(session.workspace);
      const details = document.createElement("small");

      details.textContent = [
        environments.find((e) => e.id === session.environmentId)?.name ??
          session.provider,
        ...(session.model ? [modelName(session.model)] : []),
        describe(session),
      ].join(" · ");

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
  let usage: ReadonlyMap<string, Usage> = new Map();
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
    queued.textContent = "";
    changesPanel.hidden = true;
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

        const command = (body: BrowserCommand): void => {
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
      case "changes":
        changesPanel.hidden = event.files.length === 0;
        changesSummary.textContent = `Changes (${String(event.files.length)} files)`;
        changesStat.textContent = event.stat;

        changesPatch.textContent = event.truncated
          ? "The patch is too large to show."
          : event.patch;

        return;
      case "queue":
        queued.textContent = [
          ...event.steering.map((text) => `Steering: ${text}`),
          ...event.followUp.map((text) => `Follow-up: ${text}`),
        ].join("\n");

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
        renderArchived(event.session);
        refreshSessions().catch(() => undefined);

        return;
      case "entry":
        if (event.line < lines) {
          return;
        }

        lines = event.line + 1;
        clearLive();
        chatItems(event.entry).forEach(addItem);
        usage = addUsage(usage, event.entry);
        renderUsage(describeUsage(usage));

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

function renderUsage({
  summary,
  detail,
}: ReturnType<typeof describeUsage>): void {
  usageLabel.textContent = summary;
  usageLabel.title = detail;
}

function renderArchived({ archivedAt, workspaceRemoval }: Session): void {
  const archived = archivedAt !== null;
  archiveButton.hidden = archived;
  unarchiveButton.hidden = !archived;
  removeButton.hidden = workspaceRemoval !== "kept";
  promptForm.hidden = archived;
  abortButton.hidden = archived;
  terminalButton.hidden = archived;
}

function sessionAction(action: string): void {
  if (selected !== undefined) {
    api(`/api/sessions/${encodeURIComponent(selected)}/${action}`, {}).catch(
      report,
    );
  }
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
    renderUsage({ summary: "", detail: "" });
    closeEvents = follow(sessionId);
  }

  refreshSessions().catch(() => undefined);
}

function report(error: unknown): void {
  addItem({ role: "error", text: String(error) });
}

createForm.addEventListener("input", renderEnvironments);

createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(createForm);

  const kind = form.get("kind");
  const where = form.get("location");
  const startText = form.get("start-point");
  const startPoint = typeof startText === "string" ? startText.trim() : "";
  const modelText = form.get("model");

  const model =
    typeof modelText === "string" && modelText.trim() !== ""
      ? modelRef(modelText.trim())
      : null;

  if (model === undefined) {
    alert("model must be provider/id");

    return;
  }

  api("/api/sessions", {
    environment: form.get("environment"),
    workspace:
      kind === "clone"
        ? { kind, repository: where, startPoint }
        : { kind, path: where, startPoint },
    model,
  })
    .then(async (response) => {
      location.hash = ((await response.json()) as Session).id;
    })
    .catch((error: unknown) => {
      alert(String(error));
    });
});

function sendMessage(delivery: "steer" | "followUp"): void {
  const text = promptText.value.trim();
  if (selected === undefined || text === "") {
    return;
  }

  promptText.value = "";

  api(`/api/sessions/${encodeURIComponent(selected)}/commands`, {
    type: "message",
    text,
    requestId: crypto.randomUUID(),
    delivery,
  }).catch(report);
}

promptForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage("steer");
});

promptForm.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage(event.altKey ? "followUp" : "steer");
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

archiveButton.addEventListener("click", () => {
  sessionAction("archive");
});

unarchiveButton.addEventListener("click", () => {
  sessionAction("unarchive");
});

removeButton.addEventListener("click", () => {
  if (confirm("Delete this workspace and its unpushed work for good?")) {
    sessionAction("remove-workspace");
  }
});

showArchived.addEventListener("change", () => {
  refreshSessions().catch(() => undefined);
});

window.addEventListener("hashchange", () => {
  select(location.hash.slice(1) || undefined);
});

select(location.hash.slice(1) || undefined);
refreshEnvironments().catch(() => undefined);

setInterval(() => {
  refreshSessions().catch(() => undefined);
  refreshEnvironments().catch(() => undefined);
}, sessionsRefreshMs);
