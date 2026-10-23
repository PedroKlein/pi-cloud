import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import tailwind from "bun-plugin-tailwind";

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    outfile: { type: "string", default: "dist/pi-cloud" },
  },
});

// A compiled Pi reads its version from a package.json beside the binary, and
// a single-file deploy has none.
const piVersionPlugin: Bun.BunPlugin = {
  name: "pi-version",
  setup: (build) => {
    build.onLoad(
      { filter: /pi-coding-agent[\\/]dist[\\/]config\.js$/ },
      async ({ path }) => {
        const fallback = 'pkg.version || "0.0.0"';
        const source = await readFile(path, "utf8");

        const { version } = JSON.parse(
          await readFile(join(path, "..", "..", "package.json"), "utf8"),
        ) as { version: string };

        if (!source.includes(fallback)) {
          throw new Error(`Pi's version fallback moved in ${path}`);
        }

        return {
          contents: source.replace(fallback, JSON.stringify(version)),
          loader: "js",
        };
      },
    );
  },
};

// The CLI's `bun build --compile` can't take plugins, and the web bundle needs Tailwind.
const result = await Bun.build({
  entrypoints: ["src/main.ts", "src/extensions/codemode/worker.ts"],
  root: ".",
  compile: {
    outfile: values.outfile,
    ...(values.target !== undefined && {
      target: values.target as Bun.Build.CompileTarget,
    }),
  },
  plugins: [tailwind, piVersionPlugin],
});

if (!result.success) {
  for (const log of result.logs) {
    process.stderr.write(`${log.message}\n`);
  }

  process.exit(1);
}
