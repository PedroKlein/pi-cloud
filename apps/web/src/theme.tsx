import { Icon, type IconName } from "@pipoca/ui";
import { type ReactElement, useEffect, useState } from "react";

const choices = ["system", "light", "dark"] as const;

type Choice = (typeof choices)[number];

const icons: Readonly<Record<Choice, IconName>> = {
  system: "monitor",
  light: "sun",
  dark: "moon",
};

const storageKey = "pipoca.theme";

const prefersLight = (): MediaQueryList =>
  matchMedia("(prefers-color-scheme: light)");

function stored(): Choice {
  try {
    const value = localStorage.getItem(storageKey);

    return choices.find((choice) => choice === value) ?? "system";
  } catch {
    return "system";
  }
}

// Sets data-theme on the page, so every token follows the choice.
export function applyTheme(choice: Choice = stored()): void {
  const system = prefersLight().matches ? "light" : "dark";

  document.documentElement.dataset["theme"] =
    choice === "system" ? system : choice;
}

export function ThemeSwitch(): ReactElement {
  const [choice, setChoice] = useState(stored);

  useEffect(() => {
    applyTheme(choice);

    if (choice !== "system") {
      return undefined;
    }

    const media = prefersLight();

    const follow = (): void => {
      applyTheme(choice);
    };

    media.addEventListener("change", follow);

    return () => {
      media.removeEventListener("change", follow);
    };
  }, [choice]);

  const next = choices[(choices.indexOf(choice) + 1) % choices.length];

  return (
    <button
      type="button"
      title={`Theme: ${choice}`}
      aria-label={`Theme: ${choice}. Switch to ${next ?? "system"}`}
      onClick={() => {
        const picked = next ?? "system";

        try {
          localStorage.setItem(storageKey, picked);
        } catch {
          // The choice still applies until the page reloads.
        }

        setChoice(picked);
      }}
      className="flex size-6 cursor-pointer items-center justify-center rounded-md text-fg-dim hover:bg-hover hover:text-fg"
    >
      <Icon name={icons[choice]} className="size-3.5" />
    </button>
  );
}
