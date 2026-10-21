// A compiled binary runs codemode scripts in a worker that Pi looks up at
// this path, relative to the build root. Build it as an extra entrypoint.
import "../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/worker.js";
