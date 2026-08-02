export type TerminalSplitDirection = "vertical" | "horizontal";

export type TerminalLayoutNode =
  | { kind: "leaf"; sessionId: string }
  | {
      kind: "split";
      direction: TerminalSplitDirection;
      first: TerminalLayoutNode;
      second: TerminalLayoutNode;
    };

export type TerminalLeafRect = {
  sessionId: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

export function terminalLeaf(sessionId: string): TerminalLayoutNode {
  return { kind: "leaf", sessionId };
}

export function terminalLeafIds(node: TerminalLayoutNode | null): string[] {
  if (!node) return [];
  if (node.kind === "leaf") return [node.sessionId];
  return [...terminalLeafIds(node.first), ...terminalLeafIds(node.second)];
}

// Replace only the requested leaf. Existing parents stay intact, so a vertical
// split inside the top half of a horizontal split produces two top panes and
// one bottom pane instead of re-laying out all terminals.
export function splitTerminalLeaf(
  node: TerminalLayoutNode,
  sessionId: string,
  newSessionId: string,
  direction: TerminalSplitDirection,
): TerminalLayoutNode {
  if (node.kind === "leaf") {
    if (node.sessionId !== sessionId) return node;
    return {
      kind: "split",
      direction,
      first: node,
      second: terminalLeaf(newSessionId),
    };
  }
  const first = splitTerminalLeaf(
    node.first,
    sessionId,
    newSessionId,
    direction,
  );
  if (first !== node.first) return { ...node, first };
  const second = splitTerminalLeaf(
    node.second,
    sessionId,
    newSessionId,
    direction,
  );
  return second === node.second ? node : { ...node, second };
}

// Removing a leaf promotes its sibling into the vacated parent. No empty split
// containers remain, so the surviving panes automatically consume the space.
export function removeTerminalLeaf(
  node: TerminalLayoutNode | null,
  sessionId: string,
): TerminalLayoutNode | null {
  if (!node) return null;
  if (node.kind === "leaf") {
    return node.sessionId === sessionId ? null : node;
  }
  const first = removeTerminalLeaf(node.first, sessionId);
  const second = removeTerminalLeaf(node.second, sessionId);
  if (!first) return second;
  if (!second) return first;
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

export function pruneTerminalLayout(
  node: TerminalLayoutNode | null,
  validSessionIds: ReadonlySet<string>,
): TerminalLayoutNode | null {
  if (!node) return null;
  if (node.kind === "leaf") {
    return validSessionIds.has(node.sessionId) ? node : null;
  }
  const first = pruneTerminalLayout(node.first, validSessionIds);
  const second = pruneTerminalLayout(node.second, validSessionIds);
  if (!first) return second;
  if (!second) return first;
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

export function terminalLeafRects(
  node: TerminalLayoutNode | null,
): TerminalLeafRect[] {
  if (!node) return [];
  const rects: TerminalLeafRect[] = [];
  collectRects(node, { left: 0, top: 0, width: 100, height: 100 }, rects);
  return rects;
}

function collectRects(
  node: TerminalLayoutNode,
  rect: Omit<TerminalLeafRect, "sessionId">,
  rects: TerminalLeafRect[],
) {
  if (node.kind === "leaf") {
    rects.push({ sessionId: node.sessionId, ...rect });
    return;
  }
  if (node.direction === "vertical") {
    const half = rect.width / 2;
    collectRects(node.first, { ...rect, width: half }, rects);
    collectRects(
      node.second,
      { ...rect, left: rect.left + half, width: half },
      rects,
    );
    return;
  }
  const half = rect.height / 2;
  collectRects(node.first, { ...rect, height: half }, rects);
  collectRects(
    node.second,
    { ...rect, top: rect.top + half, height: half },
    rects,
  );
}
