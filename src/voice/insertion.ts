// Format dictated text as a single unsent terminal paste. The terminator is
// intentionally never added: pressing Enter remains the user's decision.
// Without bracketed paste there is no safe way to carry newlines — a raw LF
// submits the line in shells — so interior newlines collapse to spaces.
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "email",
  "password",
  "tel",
]);

export function frameForInsertion(text: string, bracketedPaste: boolean): string {
  // Defense-in-depth: strip control characters before framing. CR/LF are kept
  // for the newline handling below; every other C0 control (crucially ESC,
  // which forms the \x1b[201~ paste terminator) is removed so a transcript can
  // never break out of the bracketed-paste frame or inject an escape sequence.
  const cleaned = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  const trimmed = cleaned.replace(/(?:\r\n|[\r\n])+$/, "");
  if (bracketedPaste) return `\x1b[200~${trimmed}\x1b[201~`;
  return trimmed.replace(/(?:\r\n|[\r\n])+/g, " ");
}

// DECSET 2004 can change while speech is being transcribed. Query it at the
// point of the write so an old terminal mode snapshot can never send raw LF.
export function terminalTextForInsertion(
  sessionId: string,
  text: string,
  bracketedPasteMode: (sessionId: string) => boolean,
): string {
  return frameForInsertion(text, bracketedPasteMode(sessionId));
}

type Editable = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

export function isTextInsertionTarget(element: Element | null): element is Editable {
  return (
    (element instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(element.type)) ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLElement && element.isContentEditable
  );
}

// Insert into ordinary app fields without pretending the browser typed a key.
// Dispatching input lets controlled React fields observe the new value.
export function insertAtCaret(element: Editable, text: string): void {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;
    element.setRangeText(text, start, end, "end");
  } else {
    const selection = window.getSelection();
    if (selection?.rangeCount) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      element.append(text);
    }
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}
