// Enter that commits an IME conversion must not submit. Safari fires that
// keydown after compositionend, so only keyCode 229 gives it away.
export function isComposing(event: {
  readonly keyCode: number;
  readonly nativeEvent: { readonly isComposing: boolean };
}): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}
