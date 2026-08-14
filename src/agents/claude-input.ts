export type ClaudePermissionRequest = {
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
  toolUseId: string | null;
  title: string | null;
  description: string | null;
  blockedPath: string | null;
  suggestions: Record<string, unknown>[];
};

export function encodeClaudeUserMessage(text: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  })}\n`;
}

export function encodeClaudePermissionResponse(
  request: ClaudePermissionRequest,
  decision: "once" | "always" | "deny",
): string {
  const response = decision === "deny"
    ? { behavior: "deny", message: "Denied by the user in KödWork." }
    : {
        behavior: "allow",
        updatedInput: request.input,
        ...(decision === "always" && request.suggestions.length > 0
          ? { updatedPermissions: request.suggestions }
          : {}),
      };
  return `${JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: request.requestId,
      response,
    },
  })}\n`;
}
