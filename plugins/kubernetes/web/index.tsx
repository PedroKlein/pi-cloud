import {
  type EnvironmentSectionProps,
  json,
  useLoaded,
  type WebPlugin,
} from "@pipoca/plugins/web";
import { Button, cn, Field, fieldClass, Section } from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import {
  defaultSettings,
  type KubernetesEnvironment,
  type KubernetesSettings,
  type PodFailure,
} from "../src/settings";

export const kubernetes: WebPlugin = {
  name: "kubernetes",
  EnvironmentSection,
};

function EnvironmentSection({
  context,
  environment,
}: EnvironmentSectionProps): ReactElement {
  const path = `environments/${encodeURIComponent(environment.id)}`;

  const { value, reload } = useLoaded(
    async () => json<KubernetesEnvironment>(context.request(path)),
    path,
    { everyMs: 10_000 },
  );

  return (
    <Section title="Kubernetes">
      <div
        aria-label="Kubernetes"
        className="flex flex-col gap-4 rounded-lg border border-line bg-elevated shadow-xs p-5 text-ui"
      >
        {value === undefined ? (
          <p className="text-fg-dim">Loading…</p>
        ) : (
          <>
            {value.lastFailure !== null && (
              <Failure failure={value.lastFailure} />
            )}
            <Settings
              key={JSON.stringify(value.settings)}
              loaded={value}
              processes={environment.isolation === "process"}
              save={async (settings) => {
                await json(context.request(path, { settings }));
                reload();
              }}
            />
          </>
        )}
      </div>
    </Section>
  );
}

function Failure({ failure }: { readonly failure: PodFailure }): ReactElement {
  const time = (iso: string): string =>
    new Date(iso).toLocaleTimeString([], { timeStyle: "short" });

  return (
    <div role="alert" className="flex flex-col gap-2 text-failed">
      <p>
        Runner pod {failure.pod} failed at {time(failure.at)}. The next one
        starts after {time(failure.retryAt)}, and each failure in a row doubles
        the wait.
      </p>
      <pre className="overflow-x-auto rounded-md border border-line bg-elevated p-3 font-mono text-mono-sm whitespace-pre-wrap text-fg">
        {failure.problem}
      </pre>
    </div>
  );
}

function Settings({
  loaded,
  processes,
  save,
}: {
  readonly loaded: KubernetesEnvironment;
  readonly processes: boolean;
  readonly save: (settings: object | null) => Promise<void>;
}): ReactElement {
  const shown = loaded.settings ?? defaultSettings;
  const [workspace, setWorkspace] = useState(shown.workspace);
  const [error, setError] = useState<string>();

  const run = (settings: object | null): void => {
    save(settings).then(
      () => {
        setError(undefined);
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();

    try {
      run(settingsOf(new FormData(event.currentTarget), shown));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const on = loaded.settings !== null;

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-fg-dim">
        {on
          ? "The server starts runner pods in its namespace for the Sessions no machine here can take."
          : "Off. The server can start runner pods in its namespace for the Sessions no machine here can take."}
      </p>
      {!loaded.startsPods && (
        <p role="note" className="text-fg-dim">
          This server isn&apos;t running in a cluster, so it starts no pods.
          Settings saved here apply once it does.
        </p>
      )}
      {!processes && (
        <p role="note" className="text-fg-dim">
          Pods run each Session as a process, so this Environment has to run
          Sessions as processes too.
        </p>
      )}
      <Field label="Workspace">
        <select
          name="workspace"
          value={workspace}
          onChange={(event) => {
            setWorkspace(event.target.value === "claim" ? "claim" : "pod");
          }}
          className={fieldClass}
        >
          <option value="pod">In the pod, gone with it</option>
          <option value="claim">
            A pod and claim for each Session, kept until it is archived
          </option>
        </select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        {workspace === "pod" && (
          <NumberField
            label="Sessions per pod"
            name="capacity"
            value={shown.capacity}
          />
        )}
        <NumberField label="Most pods" name="maxPods" value={shown.maxPods} />
        <NumberField
          label="Seconds idle before a pod stops"
          name="idleSeconds"
          value={shown.idleSeconds}
        />
      </div>
      {workspace === "claim" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Claim size">
            <input
              name="claimSize"
              required
              defaultValue={shown.claimSize}
              placeholder="10Gi"
              className={cn(fieldClass, "font-mono")}
            />
          </Field>
          <Field label="Storage class, empty for the cluster's default">
            <input
              name="storageClass"
              defaultValue={shown.storageClass ?? ""}
              className={cn(fieldClass, "font-mono")}
            />
          </Field>
        </div>
      )}
      <Field label="Pod patch, a JSON merge patch on each pod">
        <textarea
          name="podPatch"
          rows={3}
          defaultValue={JSON.stringify(shown.podPatch, null, 2)}
          placeholder='{"spec": {"nodeSelector": {"pool": "agents"}}}'
          className={cn(fieldClass, "min-h-20 resize-y font-mono text-mono-sm")}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" type="submit">
          {on ? "Save" : "Start runner pods"}
        </Button>
        {on && (
          <Button
            onClick={() => {
              run(null);
            }}
          >
            Stop runner pods
          </Button>
        )}
        {error !== undefined && (
          <p role="alert" className="text-caption text-failed">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}

function NumberField({
  label,
  name,
  value,
}: {
  readonly label: string;
  readonly name: string;
  readonly value: number;
}): ReactElement {
  return (
    <Field label={label}>
      <input
        name={name}
        type="number"
        min={1}
        required
        defaultValue={value}
        className={fieldClass}
      />
    </Field>
  );
}

// The form's fields as the settings the server checks. Fields the form
// doesn't show keep what they were.
function settingsOf(
  form: FormData,
  shown: KubernetesSettings,
): Record<string, unknown> {
  const text = (name: string): string | undefined => {
    const value = form.get(name);

    return typeof value === "string" ? value.trim() : undefined;
  };

  const number = (name: string): number | undefined => {
    const value = text(name);

    return value === undefined ? undefined : Number(value);
  };

  const storageClass = text("storageClass");
  const podPatch = text("podPatch") ?? "";

  let patch: unknown;
  try {
    patch = podPatch === "" ? {} : JSON.parse(podPatch);
  } catch {
    throw new Error("The pod patch isn't valid JSON");
  }

  return {
    workspace: text("workspace") === "claim" ? "claim" : "pod",
    capacity: number("capacity") ?? shown.capacity,
    maxPods: number("maxPods") ?? shown.maxPods,
    idleSeconds: number("idleSeconds") ?? shown.idleSeconds,
    claimSize: text("claimSize") ?? shown.claimSize,
    storageClass:
      storageClass === undefined ? shown.storageClass : storageClass || null,
    podPatch: patch,
  };
}
