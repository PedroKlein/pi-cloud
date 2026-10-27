import { readFile, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface PluginParts {
  readonly server?: string;
  readonly web?: string;
  readonly session?: string;
}

// The modules a web part shares with the shell, so there is one React and one
// design system on the page (ADR 0022). The shell puts them on
// globalThis.pipocaShared.
const sharedWebModules = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@pipoca/ui",
  "@pipoca/plugins/web",
];

// Installs an installed plugin's dependencies and bundles its parts into
// .build in its folder, so their bare imports resolve from the plugin's own
// node_modules (ADR 0022). Returns the bundles' paths, and throws with what
// went wrong.
export async function bundleParts(
  folder: string,
  entries: PluginParts,
): Promise<PluginParts> {
  await installDependencies(folder);

  const outdir = join(folder, ".build");
  await rm(outdir, { recursive: true, force: true });

  return {
    ...(entries.server !== undefined && {
      server: await bundle(entries.server, outdir, "server"),
    }),
    ...(entries.web !== undefined && {
      web: await bundle(entries.web, outdir, "web"),
    }),
    ...(entries.session !== undefined && {
      session: await bundle(entries.session, outdir, "session"),
    }),
  };
}

// A macro runs while the bundle is built, so building a plugin that isn't
// turned on would run its code. Bun.build takes this, though its types don't
// say so.
const noMacros = { macros: false };

// Each bundle is named after its part, so its URL needs no escaping.
async function bundle(
  entry: string,
  outdir: string,
  part: "server" | "web" | "session",
): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: part === "web" ? "browser" : "bun",
    naming: `${part}-[hash].[ext]`,
    throw: false,
    ...noMacros,
    ...(part === "web" && {
      plugins: [sharedWithShell],
      jsx: { development: false },
    }),
  });

  const [output, ...others] = result.outputs;

  if (!result.success || output === undefined) {
    throw new Error(
      `${basename(entry)} doesn't build: ${result.logs.map(described).join("\n")}`,
    );
  }

  // Only the bundle itself is served to the page or the runner, so a
  // stylesheet or file it imports would be missing there.
  if (part !== "server" && others.length > 0) {
    throw new Error(
      part === "web"
        ? `${basename(entry)} imports CSS or other files, which a web part can't have yet; style it with @pipoca/ui`
        : `${basename(entry)} imports files other than code, which a Session part can't have yet`,
    );
  }

  return output.path;
}

const sharedWithShell: Bun.BunPlugin = {
  name: "shared-with-shell",
  setup: (build) => {
    build.onResolve({ filter: /^[@a-z]/ }, ({ path }) =>
      sharedWebModules.includes(path)
        ? { path, namespace: "pipoca-shared" }
        : undefined,
    );

    build.onLoad({ filter: /.*/, namespace: "pipoca-shared" }, ({ path }) => ({
      contents: `module.exports = globalThis.pipocaShared[${JSON.stringify(path)}];`,
      loader: "js",
    }));
  },
};

function described(log: BuildMessage | ResolveMessage): string {
  const { position, message } = log;

  return position === null
    ? message
    : `${position.file}:${String(position.line)}:${String(position.column)}: ${message}`;
}

const installTimeoutMs = 2 * 60_000;

// Fields that make bun install reach outside the plugin's folder, or set up
// what it does from inside it.
const outsideFields = ["workspaces", "patchedDependencies"];

const specFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "overrides",
  "resolutions",
];

const pathSpec = /^file:(.*)$|^([./~].*)$/;

const configFiles = ["bunfig.toml", ".npmrc"];

// A dependency from a path, such as one vendored in the plugin, stays inside
// its folder even through links.
async function stays(folder: string, spec: string): Promise<boolean> {
  // link: names a package registered with bun link on the machine.
  if (/^(workspace|link|portal):/.test(spec)) {
    return false;
  }

  const match = pathSpec.exec(spec);
  const path = match?.[1] ?? match?.[2];

  if (path === undefined) {
    return true;
  }

  if (path.startsWith("~") || isAbsolute(path)) {
    return false;
  }

  const real = await realpath(resolve(folder, path)).catch(() =>
    resolve(folder, path),
  );

  const within = relative(await realpath(folder), real);

  return !isAbsolute(within) && within.split(sep)[0] !== "..";
}

async function installDependencies(folder: string): Promise<void> {
  const packageJson = JSON.parse(
    await readFile(join(folder, "package.json"), "utf8"),
  ) as Record<string, unknown>;

  for (const field of outsideFields) {
    if (packageJson[field] !== undefined) {
      throw new Error(`a plugin's package.json can't have ${field}`);
    }
  }

  const specs = specFields.flatMap((field) =>
    Object.entries((packageJson[field] ?? {}) as Record<string, unknown>),
  );

  for (const [name, spec] of specs) {
    if (typeof spec !== "string" || !(await stays(folder, spec))) {
      throw new Error(
        `${name} must come from a registry, a URL or the plugin's own folder, not from elsewhere on the server`,
      );
    }
  }

  for (const file of configFiles) {
    if (await Bun.file(join(folder, file)).exists()) {
      throw new Error(
        `a plugin can't have ${file}, which would configure the server's install`,
      );
    }
  }

  const { dependencies } = packageJson as {
    dependencies?: Record<string, string>;
  };

  if (dependencies === undefined || Object.keys(dependencies).length === 0) {
    return;
  }

  // BUN_BE_BUN makes the compiled server act as the bun CLI, so installing
  // needs no npm on the machine. The server waits for this before it
  // listens, so a registry that never answers can't hold it forever, and the
  // plugin's own scripts don't run on every start.
  const install = Bun.spawn([process.execPath, "install", "--ignore-scripts"], {
    cwd: folder,
    env: { ...process.env, BUN_BE_BUN: "1" },
    stdout: "ignore",
    stderr: "pipe",
    timeout: installTimeoutMs,
  });

  const [code, errors] = await Promise.all([
    install.exited,
    new Response(install.stderr).text(),
  ]);

  if (install.signalCode !== null) {
    throw new Error(
      `installing its dependencies took longer than ${String(installTimeoutMs / 60_000)} minutes`,
    );
  }

  if (code !== 0) {
    throw new Error(`installing its dependencies failed: ${errors.trim()}`);
  }
}
