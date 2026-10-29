import {
  type Answer,
  type Attempt,
  type Command,
  checkoutName,
  type CreateEnvironment,
  type CreateSession,
  type EnvironmentUpdate,
  type ImageAttachment,
  imageLimits,
  imageTypes,
  isolations,
  type JoinRequest,
  type LiveEvent,
  type LivePost,
  type ModelRef,
  type QuestionAnswer,
  type RemovalPost,
  type RemovalReport,
  type RepositoryCheckout,
  type Selection,
  type StartFailure,
  type ThinkingLevel,
  thinkingLevels,
  type ToolCall,
  type TranscriptBatch,
  type TrustAnswer,
  type WorkPoll,
  type Workspace,
  type WorkspaceRequest,
} from "@pipoca/protocol";
import { BadRequest, fieldsOf } from "@pipoca/plugins";
import type { UserActor } from "@pipoca/pluginhost";

function thinkingOf(value: unknown, field = "thinking"): ThinkingLevel {
  const level = thinkingLevels.find((known) => known === value);
  if (level === undefined) {
    throw new BadRequest(
      `${field} must be one of ${thinkingLevels.join(", ")}`,
    );
  }

  return level;
}

export function createFork(body: unknown): {
  readonly environment?: string;
  readonly entry?: string;
} {
  const { environment, entry } = (body ?? {}) as Record<string, unknown>;

  for (const [field, value] of Object.entries({ environment, entry })) {
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "string" || value === "")
    ) {
      throw new BadRequest(`${field} must be a non-empty string`);
    }
  }

  return {
    ...(typeof environment === "string" && { environment }),
    ...(typeof entry === "string" && { entry }),
  };
}

export function createSession(body: unknown): CreateSession {
  const {
    environment,
    profile,
    workspace,
    model,
    thinking,
    systemPrompt,
    firstMessage,
  } = (body ?? {}) as Record<string, unknown>;

  if (
    environment !== undefined &&
    environment !== null &&
    (typeof environment !== "string" || environment === "")
  ) {
    throw new BadRequest("environment must be a non-empty string");
  }

  if (
    profile !== undefined &&
    profile !== null &&
    (typeof profile !== "string" || profile === "")
  ) {
    throw new BadRequest("profile must be a non-empty string");
  }

  const request = {
    ...(typeof environment === "string" && { environment }),
    ...(typeof profile === "string" && { profile }),
    workspace: workspaceRequest(workspace),
    ...optionalText("systemPrompt", systemPrompt),
    ...optionalText("firstMessage", firstMessage),
    ...(thinking !== undefined &&
      thinking !== null && { thinking: thinkingOf(thinking) }),
  };

  if (model === undefined || model === null) {
    return request;
  }

  const { provider: modelProvider, id } = model as Record<string, unknown>;
  if (
    typeof modelProvider !== "string" ||
    modelProvider === "" ||
    typeof id !== "string" ||
    id === ""
  ) {
    throw new BadRequest("model must have a provider and an id");
  }

  return { ...request, model: { provider: modelProvider, id } };
}

const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;

// A docker reference: no leading dash, so docker never reads it as a flag.
const imageName = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

const maxVariables = 200;

// Well under Linux's limit on one environment string, so spawns don't fail.
const maxVariableBytes = 32 * 1024;

export function environmentUpdate(body: unknown): EnvironmentUpdate {
  const { name, isolation, image, setupScript, variables, secrets } = (body ??
    {}) as Record<string, unknown>;

  if (name !== undefined && (typeof name !== "string" || name.trim() === "")) {
    throw new BadRequest("name must be a non-empty string");
  }

  const isolationLevel = isolations.find((known) => known === isolation);
  if (isolation !== undefined && isolationLevel === undefined) {
    throw new BadRequest(`isolation must be one of ${isolations.join(", ")}`);
  }

  if (
    image !== undefined &&
    image !== null &&
    (typeof image !== "string" || !imageName.test(image))
  ) {
    throw new BadRequest(
      "image must be an image name, such as debian:12, or null",
    );
  }

  if (setupScript !== undefined && typeof setupScript !== "string") {
    throw new BadRequest("setupScript must be a string");
  }

  return {
    ...(name !== undefined && { name: name.trim() }),
    ...(isolationLevel !== undefined && { isolation: isolationLevel }),
    ...(image !== undefined && { image }),
    ...(setupScript !== undefined && { setupScript }),
    ...(variables !== undefined && {
      variables: namedValues("variables", variables, false),
    }),
    ...(secrets !== undefined && {
      secrets: namedValues("secrets", secrets, true),
    }),
  };
}

function namedValues<Nullable extends boolean>(
  field: string,
  value: unknown,
  nullable: Nullable,
): Record<string, Nullable extends true ? string | null : string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequest(`${field} must be an object`);
  }

  const entries = Object.entries(value);
  if (entries.length > maxVariables) {
    throw new BadRequest(
      `${field} can hold at most ${String(maxVariables)} entries`,
    );
  }

  for (const [key, each] of entries) {
    if (!variableName.test(key)) {
      throw new BadRequest(`${field} has an invalid name: ${key}`);
    }

    if (nullable && each === null) {
      continue;
    }

    if (
      typeof each !== "string" ||
      each.includes("\0") ||
      Buffer.byteLength(each) > maxVariableBytes
    ) {
      throw new BadRequest(
        `${field}.${key} must be a string of at most ${String(maxVariableBytes)} bytes without NUL`,
      );
    }
  }

  return value as Record<
    string,
    Nullable extends true ? string | null : string
  >;
}

function optionalText<K extends string>(
  key: K,
  value: unknown,
): Partial<Record<K, string>> {
  if (value === undefined || value === null || value === "") {
    return {};
  }

  if (typeof value !== "string") {
    throw new BadRequest(`${key} must be a string`);
  }

  return { [key]: value } as Partial<Record<K, string>>;
}

function workspaceRequest(workspace: unknown): WorkspaceRequest {
  const { kind, path, repository, repositories, startPoint } = (workspace ??
    {}) as Record<string, unknown>;

  if (kind === "folder" && typeof path === "string" && path !== "") {
    return { kind, path };
  }

  const start = startPointOf(startPoint);

  if (kind === "worktree" && typeof path === "string" && path !== "") {
    return { kind, path, ...start };
  }

  if (kind === "clone" && typeof repository === "string" && repository !== "") {
    refuseCredentials(repository);

    return { kind, repository, ...start };
  }

  if (
    kind === "repositories" &&
    Array.isArray(repositories) &&
    repositories.length > 0
  ) {
    const checkouts = repositories.map(repositoryCheckout);
    const names = checkouts.map((c) => checkoutName(c.repository));
    if (names.includes(undefined) || new Set(names).size !== names.length) {
      throw new BadRequest("repositories need different names");
    }

    return { kind, repositories: checkouts };
  }

  throw new BadRequest(
    "workspace must be a folder or worktree with a path, a clone with a repository, or repositories",
  );
}

function repositoryCheckout(checkout: unknown): RepositoryCheckout {
  const { repository, startPoint } = (checkout ?? {}) as Record<
    string,
    unknown
  >;

  if (typeof repository !== "string" || repository === "") {
    throw new BadRequest("each repository needs a URL");
  }

  refuseCredentials(repository);

  return { repository, ...startPointOf(startPoint) };
}

// A token or password in a URL would be stored with the Session and logged.
// An ssh user name alone, such as git@, is not a credential.
function refuseCredentials(repository: string): void {
  const url = URL.parse(repository);

  if (
    url !== null &&
    (url.password !== "" ||
      (url.username !== "" && url.protocol.startsWith("http")))
  ) {
    throw new BadRequest(
      "repository URLs can't hold credentials: connect the git host instead",
    );
  }
}

// Terminal and preview commands come from the server's own sockets and
// previews, never from a browser's POST.
export function browserCommand(body: unknown, actor: UserActor): Command {
  const fields = (
    typeof body === "object" && body !== null ? body : {}
  ) as Record<string, unknown>;

  const text = (key: string): string => {
    const value = fields[key];
    if (typeof value !== "string") {
      throw new BadRequest(`${key} must be a string`);
    }

    return value;
  };

  switch (fields["type"]) {
    case "message": {
      const { requestId, delivery } = fields;
      if (requestId !== undefined && typeof requestId !== "string") {
        throw new BadRequest("requestId must be a string");
      }

      if (
        delivery !== undefined &&
        delivery !== "steer" &&
        delivery !== "followUp"
      ) {
        throw new BadRequest('delivery must be "steer" or "followUp"');
      }

      const images =
        fields["images"] === undefined ? undefined : imagesOf(fields["images"]);

      return {
        actor,
        type: "message",
        text: text("text"),
        ...(images !== undefined && { images }),
        ...(requestId !== undefined && { requestId }),
        ...(delivery !== undefined && { delivery }),
      };
    }

    case "abort":
      return { actor, type: "abort" };
    case "set_model":
      return {
        actor,
        type: "set_model",
        model: modelOf(fields["model"]),
      };
    case "set_thinking":
      return {
        actor,
        type: "set_thinking",
        level: thinkingOf(fields["level"], "level"),
      };

    case "unqueue": {
      const { delivery, sendNow } = fields;
      if (delivery !== "steer" && delivery !== "followUp") {
        throw new BadRequest('delivery must be "steer" or "followUp"');
      }

      if (sendNow !== undefined && typeof sendNow !== "boolean") {
        throw new BadRequest("sendNow must be a boolean");
      }

      return {
        actor,
        type: "unqueue",
        delivery,
        text: text("text"),
        ...(sendNow === true && { sendNow }),
      };
    }

    case "ui_columns": {
      const { columns } = fields;
      if (
        typeof columns !== "number" ||
        !Number.isInteger(columns) ||
        columns < 1 ||
        columns > 1000
      ) {
        throw new BadRequest("columns must be a whole number from 1 to 1000");
      }

      return { actor, type: "ui_columns", columns };
    }

    case "answer":
      return {
        actor,
        type: "answer",
        id: text("id"),
        value: answerOf(fields["value"]),
      };
    case "explain": {
      const { question } = fields;
      if (question !== null && typeof question !== "string") {
        throw new BadRequest("question must be a string or null");
      }

      return {
        actor,
        type: "explain",
        id: text("id"),
        questionId: text("questionId"),
        value: text("value"),
        question,
      };
    }

    case "close_page":
      return { actor, type: "close_page", id: text("id") };
    default:
      throw new BadRequest(
        "type must be message, abort, set_model, set_thinking, ui_columns, unqueue, answer, explain or close_page",
      );
  }
}

function answerOf(value: unknown): Answer {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequest(
      "value must be a string, boolean, null or questions answer",
    );
  }

  const { answers, note } = fieldsOf(value);

  return {
    answers: listOf("answers", answers, questionAnswerOf),
    note: textOrNullOf("note", note),
  };
}

function questionAnswerOf(answer: unknown): QuestionAnswer {
  const { id, type, selections, text, value } = fieldsOf(answer);

  switch (type) {
    case "choice":
      return {
        id: textOf("id", id),
        type,
        selections: listOf("selections", selections, selectionOf),
      };
    case "text":
      return { id: textOf("id", id), type, text: textOf("text", text) };
    case "number":
      if (typeof value !== "number") {
        throw new BadRequest("value must be a number");
      }

      return { id: textOf("id", id), type, value };
    default:
      throw new BadRequest("each answer must be choice, text or number");
  }
}

function selectionOf(selection: unknown): Selection {
  const { value, label, custom, annotation } = fieldsOf(selection);
  if (typeof custom !== "boolean") {
    throw new BadRequest("custom must be a boolean");
  }

  return {
    value: textOf("value", value),
    label: textOf("label", label),
    custom,
    annotation: textOrNullOf("annotation", annotation),
  };
}

function imagesOf(value: unknown): readonly ImageAttachment[] {
  if (!Array.isArray(value) || value.length > imageLimits.count) {
    throw new BadRequest(
      `images must be a list of at most ${String(imageLimits.count)}`,
    );
  }

  return value.map((image: unknown): ImageAttachment => {
    const { mimeType, data } = (
      typeof image === "object" && image !== null ? image : {}
    ) as Record<string, unknown>;

    const type = imageTypes.find((known) => known === mimeType);
    if (type === undefined) {
      throw new BadRequest(`images must be ${imageTypes.join(", ")}`);
    }

    if (typeof data !== "string" || !base64.test(data)) {
      throw new BadRequest("image data must be base64");
    }

    if (Buffer.byteLength(data, "base64") > imageLimits.bytes) {
      throw new BadRequest(
        `each image must be at most ${String(imageLimits.bytes / 1024 / 1024)} MB`,
      );
    }

    return { mimeType: type, data };
  });
}

const base64 = /^[A-Za-z0-9+/]*={0,2}$/;

function startPointOf(startPoint: unknown): { startPoint?: string } {
  if (startPoint === undefined || startPoint === null || startPoint === "") {
    return {};
  }

  // A leading dash would reach git as an option.
  if (typeof startPoint !== "string" || startPoint.startsWith("-")) {
    throw new BadRequest("startPoint must be a branch, tag or commit");
  }

  return { startPoint };
}

export function toolCall(body: unknown): ToolCall {
  const { generation, id, name, input } = fieldsOf(body);

  return {
    generation: integerOf("generation", generation),
    id: textOf("id", id),
    name: textOf("name", name),
    input,
  };
}

// Runner and Environment names show in logs, container names and paths.
const agentName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function nameOf(key: string, value: unknown): string {
  const name = textOf(key, value);
  if (!agentName.test(name)) {
    throw new BadRequest(
      `${key} must be 1 to 64 letters, digits, dots, dashes or underscores`,
    );
  }

  return name;
}

export function joinRequest(body: unknown): JoinRequest {
  return { name: nameOf("name", fieldsOf(body)["name"]) };
}

export function createEnvironment(body: unknown): CreateEnvironment {
  return { name: nameOf("name", fieldsOf(body)["name"]) };
}

export function workPoll(body: unknown): WorkPoll {
  const { running, folders, models, registeredModels, capacity, session } =
    fieldsOf(body);

  return {
    running: listOf("running", running, attemptOf),
    folders: listOf("folders", folders, (folder) =>
      textOf("each folder", folder),
    ),
    models: listOf("models", models, modelOf),
    ...(registeredModels !== undefined && {
      registeredModels: listOf("registeredModels", registeredModels, modelOf),
    }),
    ...(capacity !== undefined && { capacity: capacityOf(capacity) }),
    ...(session !== undefined && { session: textOf("session", session) }),
  };
}

function capacityOf(value: unknown): number {
  const capacity = integerOf("capacity", value);
  if (capacity < 1) {
    throw new BadRequest("capacity must be at least 1");
  }

  return capacity;
}

function attemptOf(attempt: unknown): Attempt {
  const { sessionId, generation } = fieldsOf(attempt);

  return {
    sessionId: textOf("sessionId", sessionId),
    generation: integerOf("generation", generation),
  };
}

function modelOf(model: unknown): ModelRef {
  const { provider, id } = fieldsOf(model);

  return { provider: textOf("provider", provider), id: textOf("id", id) };
}

export function transcriptBatch(body: unknown): TranscriptBatch {
  const { generation, start, lines } = fieldsOf(body);
  if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 0) {
    throw new BadRequest("start must be a non-negative integer");
  }

  return {
    generation: integerOf("generation", generation),
    start,
    lines: listOf("lines", lines, (line) => textOf("each line", line)),
  };
}

export function startFailure(body: unknown): StartFailure {
  const { generation, error } = fieldsOf(body);

  return {
    generation: integerOf("generation", generation),
    error: textOf("error", error),
  };
}

export function trustAnswer(body: unknown): TrustAnswer {
  const { generation, trusted } = fieldsOf(body);
  if (typeof trusted !== "boolean") {
    throw new BadRequest("trusted must be true or false");
  }

  return { generation: integerOf("generation", generation), trusted };
}

export function removalPost(body: unknown): RemovalPost {
  const { generation } = fieldsOf(body);

  return {
    ...removalReport(body),
    generation: integerOf("generation", generation),
  };
}

function removalReport(body: unknown): RemovalReport {
  const { outcome, restore, reason } = fieldsOf(body);

  switch (outcome) {
    case "removed":
      return { outcome, restore: workspaceOf(restore) };
    case "kept":
      return {
        outcome,
        reason: textOf("reason", reason),
        ...(restore !== undefined && { restore: workspaceOf(restore) }),
      };
    default:
      throw new BadRequest('outcome must be "removed" or "kept"');
  }
}

function workspaceOf(restore: unknown): Workspace {
  if (typeof fieldsOf(restore)["kind"] !== "string") {
    throw new BadRequest("restore must be a workspace with a kind");
  }

  return restore as Workspace;
}

export function livePost(body: unknown): LivePost {
  const { generation, events } = fieldsOf(body);

  return {
    generation: integerOf("generation", generation),
    events: listOf("events", events, liveEventOf),
  };
}

// Only a status event changes the stored Session. The rest pass through to
// browsers unchecked, so events from a newer agent still reach them.
function liveEventOf(event: unknown): LiveEvent {
  const { type, status, transcriptLength } = fieldsOf(event);
  if (typeof type !== "string") {
    throw new BadRequest("each event needs a type");
  }

  if (type === "ui_action") {
    throw new BadRequest("only the server sends ui_action");
  }

  if (type === "status" && status !== "idle" && status !== "running") {
    throw new BadRequest('status must be "idle" or "running"');
  }

  if (
    type === "status" &&
    transcriptLength !== undefined &&
    integerOf("transcriptLength", transcriptLength) < 0
  ) {
    throw new BadRequest("transcriptLength must not be negative");
  }

  return event as LiveEvent;
}

export function textOf(key: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new BadRequest(`${key} must be a string`);
  }

  return value;
}

function textOrNullOf(key: string, value: unknown): string | null {
  if (value !== null && typeof value !== "string") {
    throw new BadRequest(`${key} must be a string or null`);
  }

  return value;
}

function integerOf(key: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new BadRequest(`${key} must be an integer`);
  }

  return value;
}

export function listOf<T>(
  key: string,
  value: unknown,
  item: (entry: unknown) => T,
): readonly T[] {
  if (!Array.isArray(value)) {
    throw new BadRequest(`${key} must be a list`);
  }

  return value.map((entry: unknown) => item(entry));
}

export function lineAfter(lastEventId: string | null): number {
  const line = Number(lastEventId ?? "");

  return lastEventId !== null && Number.isSafeInteger(line) && line >= 0
    ? line + 1
    : 0;
}
