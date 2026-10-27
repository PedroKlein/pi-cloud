// Pi's own binary embeds the QuickJS wasm that runs codemode scripts and
// tells Pi where it is, in setup code the package doesn't export. A compiled
// pipoca does the same, so codemode works there too.
import { setEmbeddedQuickJSWasmPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/config.js";
import wasm from "quickjs-wasi/quickjs.wasm" with { type: "file" };

setEmbeddedQuickJSWasmPath(wasm);
