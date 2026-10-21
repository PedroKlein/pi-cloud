import tailwind from "bun-plugin-tailwind";

// The CLI's `bun build --compile` can't take plugins, and the web bundle needs Tailwind.
const result = await Bun.build({
  entrypoints: ["src/main.ts", "src/extensions/codemode/worker.ts"],
  root: ".",
  compile: { outfile: "dist/pi-cloud" },
  plugins: [tailwind],
});

if (!result.success) {
  for (const log of result.logs) {
    process.stderr.write(`${log.message}\n`);
  }

  process.exit(1);
}
