import type { ModelRef } from "@pipoca/protocol";

function modelName({ provider, id }: ModelRef): string {
  return `${provider}/${id}`;
}

export interface ModelOption {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
  readonly group: string;
}

const recentKey = "pipoca.recentModels";
const recentCount = 5;

// A list this long still fits without folding providers away.
const shortList = 8;

// The model menus' options: aliases first, then each provider's models, with
// the ones last picked in this browser on top once the list gets long.
export function modelOptions(
  models: readonly ModelRef[],
  recent: readonly string[] = recentModels(),
): {
  readonly options: readonly ModelOption[];
  readonly openGroups?: readonly string[];
} {
  const sorted = [...models].sort(
    (a, b) =>
      Number(b.provider === "alias") - Number(a.provider === "alias") ||
      a.provider.localeCompare(b.provider),
  );

  const listed = sorted.map((model) => ({
    value: modelName(model),
    label: model.id,
    group: model.provider,
  }));

  if (listed.length <= shortList) {
    return { options: listed };
  }

  const known = new Map(sorted.map((model) => [modelName(model), model]));

  const recents = recent.flatMap((name) => {
    const model = known.get(name);

    return model
      ? [
          {
            value: name,
            label: model.id,
            detail: model.provider,
            group: "Recent",
          },
        ]
      : [];
  });

  return {
    options: [...recents, ...listed],
    openGroups: ["Recent", "alias"],
  };
}

export function recentModels(): readonly string[] {
  try {
    const saved = JSON.parse(
      localStorage.getItem(recentKey) ?? "[]",
    ) as unknown;

    return Array.isArray(saved)
      ? saved.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
}

export function rememberModel(name: string): void {
  try {
    localStorage.setItem(
      recentKey,
      JSON.stringify(
        [name, ...recentModels().filter((known) => known !== name)].slice(
          0,
          recentCount,
        ),
      ),
    );
  } catch {
    // Recent models only last this visit.
  }
}
