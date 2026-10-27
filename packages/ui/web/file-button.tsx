import type { InputHTMLAttributes, ReactElement, ReactNode } from "react";
import { buttonClass } from "./button";
import { Icon } from "./icon";

// A button that opens the file chooser. The input stays in the page, so its
// label, accept and multiple still work for screen readers and tests.
export function FileButton({
  children,
  className,
  onFiles,
  ...input
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> & {
  readonly children: ReactNode;
  readonly onFiles: (files: readonly File[]) => void;
}): ReactElement {
  return (
    <label
      className={buttonClass(
        "default",
        false,
        `has-focus-visible:border-line-focus has-focus-visible:ring-4 has-focus-visible:ring-focus ${className ?? ""}`,
      )}
    >
      <Icon name="upload" className="text-fg-dim" />
      {children}
      <input
        type="file"
        className="sr-only"
        onChange={(event) => {
          const { files } = event.target;

          if (files && files.length > 0) {
            onFiles([...files]);
          }

          event.target.value = "";
        }}
        {...input}
      />
    </label>
  );
}
