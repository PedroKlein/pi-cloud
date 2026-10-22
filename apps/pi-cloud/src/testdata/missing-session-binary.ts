// The agent starts each session process from its own executable. Pointing
// that at a missing file reproduces a binary removed while the agent runs.
Object.defineProperty(process, "execPath", { value: "/no/such/pi-cloud" });
