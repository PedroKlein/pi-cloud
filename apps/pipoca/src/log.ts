import type { Log } from "@pipoca/providers";

export function stderrLog(component: string): Log {
  return (message, fields) => {
    const line = {
      time: new Date().toISOString(),
      component,
      message,
      ...fields,
    };

    process.stderr.write(`${JSON.stringify(line)}\n`);
  };
}
