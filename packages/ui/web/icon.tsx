import type { ReactElement } from "react";
import { cn } from "./cn";

// Paths from Lucide (ISC license, https://lucide.dev/license).
const paths = {
  archive: [
    "M3 3h18a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z",
    "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8",
    "M10 12h4",
  ],
  "arrow-up": ["m5 12 7-7 7 7", "M12 19V5"],
  bell: [
    "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9",
    "M10.3 21a1.94 1.94 0 0 0 3.4 0",
  ],
  check: ["M20 6 9 17l-5-5"],
  "chevron-down": ["m6 9 6 6 6-6"],
  "chevron-right": ["m9 18 6-6-6-6"],
  chat: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
  "external-link": [
    "M15 3h6v6",
    "M10 14 21 3",
    "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  ],
  "git-pull-request": [
    "M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    "M13 6h3a2 2 0 0 1 2 2v7",
    "M6 9v12",
  ],
  info: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 16v-4", "M12 8h.01"],
  monitor: [
    "M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
    "M8 21h8",
    "M12 17v4",
  ],
  moon: ["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"],
  menu: ["M4 6h16", "M4 12h16", "M4 18h16"],
  paperclip: [
    "m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551",
  ],
  plus: ["M5 12h14", "M12 5v14"],
  stop: [
    "M7 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z",
  ],
  sun: [
    "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    "M12 2v2",
    "M12 20v2",
    "m4.93 4.93 1.41 1.41",
    "m17.66 17.66 1.41 1.41",
    "M2 12h2",
    "M20 12h2",
    "m6.34 17.66-1.41 1.41",
    "m19.07 4.93-1.41 1.41",
  ],
  terminal: ["m4 17 6-6-6-6", "M12 19h8"],
  trash: [
    "M3 6h18",
    "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
    "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  ],
  x: ["M18 6 6 18", "m6 6 12 12"],
} as const;

export type IconName = keyof typeof paths;

export function Icon({
  name,
  className,
}: {
  readonly name: IconName;
  readonly className?: string;
}): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("size-4 shrink-0", className)}
    >
      {paths[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
