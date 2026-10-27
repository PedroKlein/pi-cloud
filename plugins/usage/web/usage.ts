export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
}

interface Entry {
  readonly type: string;
  readonly message?: {
    readonly role: string;
    readonly provider?: string;
    readonly model?: string;
    readonly usage?: Usage & { readonly cost: { readonly total: number } };
  };
}

const none: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
};

export function addUsage(
  totals: ReadonlyMap<string, Usage>,
  line: string,
): ReadonlyMap<string, Usage> {
  const { type, message } = JSON.parse(line) as Entry;
  if (type !== "message" || message?.role !== "assistant" || !message.usage) {
    return totals;
  }

  const model = `${message.provider ?? "?"}/${message.model ?? "?"}`;
  const sum = totals.get(model) ?? none;
  const { usage } = message;

  return new Map(totals).set(model, {
    input: sum.input + usage.input,
    output: sum.output + usage.output,
    cacheRead: sum.cacheRead + usage.cacheRead,
    cacheWrite: sum.cacheWrite + usage.cacheWrite,
    cost: sum.cost + usage.cost.total,
  });
}

export function describeUsage(totals: ReadonlyMap<string, Usage>): {
  readonly summary: string;
  readonly detail: string;
  readonly cost: string;
} {
  const describe = (usage: Usage): string =>
    `${tokens(usage.input + usage.cacheRead + usage.cacheWrite)} in · ${tokens(usage.output)} out · $${usage.cost.toFixed(4)}`;

  const all = [...totals.values()].reduce(
    (sum, usage) => ({
      input: sum.input + usage.input,
      output: sum.output + usage.output,
      cacheRead: sum.cacheRead + usage.cacheRead,
      cacheWrite: sum.cacheWrite + usage.cacheWrite,
      cost: sum.cost + usage.cost,
    }),
    none,
  );

  return {
    summary: totals.size === 0 ? "" : describe(all),
    cost:
      all.cost > 0 && all.cost < 0.01 ? "<$0.01" : `$${all.cost.toFixed(2)}`,
    detail: [...totals]
      .map(([model, usage]) => `${model}: ${describe(usage)}`)
      .join("\n"),
  };
}

// Pi's estimate of the context, with no tokens right after a compaction.
export function describeContext(
  inContext: number | null,
  window: number,
): string {
  if (inContext === null) {
    return `? / ${tokens(window)}`;
  }

  return `${tokens(inContext)} / ${tokens(window)} (${String(Math.round((inContext / window) * 100))}%)`;
}

function tokens(count: number): string {
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}
