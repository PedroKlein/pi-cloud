// Bun imports a .wasm file as its path, embedded in compiled binaries.
declare module "*.wasm" {
  const path: string;
  export = path;
}
