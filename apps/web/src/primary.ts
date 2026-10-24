import { createContext, useContext } from "react";

// Element ids are kept for the page's main Session view. A second view, such
// as a Project thread beside its coordinator, goes without them (ADR 0028).
export const PrimaryView = createContext(true);

export function usePrimaryId(id: string): string | undefined {
  return useContext(PrimaryView) ? id : undefined;
}
