import { tmpdir } from "node:os";
import { join } from "node:path";

// Session terminals start $SHELL, and a developer's interactive shell config
// (prompt plugins, slow startup, typeahead handling) shouldn't decide whether
// tests pass.
process.env["SHELL"] = "/bin/sh";

// Session processes load a real Pi, which would otherwise refresh its model
// catalog over the network.
process.env["PI_OFFLINE"] = "1";

// Sessions hosted in the test's own process can't set Pi's agent folder for
// its MCP extension, which then uses this one instead of the developer's own
// ~/.pi/agent.
process.env["PI_CODING_AGENT_DIR"] = join(tmpdir(), "pi-cloud-test-agent");
