/** How a saved record names the connection that produced it. Records written
 * before the Claude CLI keep their original label; new work names its own
 * provider. */
export function providerLabel(provider: string | undefined): string {
  if (provider === "claude-cli") return "Claude CLI";
  if (provider === "chatgpt-handoff") return "ChatGPT handoff";
  return "the study bridge";
}
