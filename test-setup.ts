// Session terminals start $SHELL, and a developer's interactive shell config
// (prompt plugins, slow startup, typeahead handling) shouldn't decide whether
// tests pass.
process.env["SHELL"] = "/bin/sh";

// Session processes load a real Pi, which would otherwise refresh its model
// catalog over the network.
process.env["PI_OFFLINE"] = "1";
