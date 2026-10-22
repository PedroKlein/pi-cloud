import { parseArgs } from "node:util";
import tailwind from "bun-plugin-tailwind";

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    outfile: { type: "string", default: "dist/pi-cloud" },
  },
});

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
  plugins: [tailwind],
});

if (!result.success) {
  for (const log of result.logs) {
    process.stderr.write(`${log.message}\n`);
  }

  process.exit(1);
}
