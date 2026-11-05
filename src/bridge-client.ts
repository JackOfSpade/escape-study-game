import { isRecord } from "./records";
/** Provider transport only; gameplay and learning remain in their owning modules. */
export type DisconnectReason =
  | "relay-unreachable"
  | "gateway-off"
  | "cli-missing"
  | "signed-out";
const REASONS: readonly unknown[] = [
  "relay-unreachable",
  "gateway-off",
  "cli-missing",
  "signed-out",
];
export interface BridgeStatus {
  /** "development" means Claude is not connected, so terminals are locked. */
  mode: "development" | "claude-cli";
  label: string;
  reason?: DisconnectReason;
  capabilities: string[];
  detail: string;
}
let bridgeStatus: BridgeStatus = {
  mode: "development",
  label: "Claude not connected",
  reason: "relay-unreachable",
  capabilities: [],
  detail: "Claude CLI study connection is not available.",
};
export const status = () => bridgeStatus;
let checkVersion = 0;
export async function checkBridge() {
  const version = ++checkVersion;
  try {
    const r = await fetch("/api/status", { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw Error();
    const info = await r.json();
    if (
      !isRecord(info) ||
      (info.mode !== "development" && info.mode !== "claude-cli") ||
      !Array.isArray(info.capabilities) ||
      !info.capabilities.every((cap: unknown) => typeof cap === "string") ||
      typeof info.label !== "string" ||
      typeof info.detail !== "string"
    )
      throw Error("Malformed bridge capability handshake");
    if (version === checkVersion)
      bridgeStatus = {
        mode: info.mode,
        label: info.label,
        ...(REASONS.includes(info.reason)
          ? { reason: info.reason as DisconnectReason }
          : {}),
        capabilities: info.capabilities,
        detail: info.detail,
      };
  } catch {
    if (version === checkVersion)
      bridgeStatus = {
        mode: "development",
        label: "Claude not connected",
        reason: "relay-unreachable",
        capabilities: [],
        detail: "The study relay is not reachable.",
      };
  }
  return bridgeStatus;
}
/** How long one request waits for the bridge to answer. */
export const REQUEST_TIMEOUT_MS = 30 * 60_000;
/** Bridge errors may come from a proxy as plain text; never surface a JSON
 * parse failure in place of the real reason. */
async function readJson(r: Response) {
  const text = await r.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    if (r.ok) throw Error("Malformed bridge response");
    if (r.status >= 502 && r.status <= 504)
      return {
        error:
          "The study bridge is not running. It is restarting; press Retry connection in a moment. Your work is saved.",
      };
    return { error: text.trim().slice(0, 200) || `Bridge HTTP ${r.status}` };
  }
  if (!isRecord(data)) throw Error("Malformed bridge response");
  return data;
}
/** Each line is the text so far, then one final answer or error. */
async function readStream(r: Response, onText: (text: string) => void) {
  const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw Error("The reply ended before its answer arrived");
    buffer += value;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const event: unknown = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (!isRecord(event)) throw Error("Malformed bridge response");
      if (typeof event.error === "string") throw Error(event.error);
      if (isRecord(event.answer)) return event.answer;
      if (typeof event.text === "string") onText(event.text);
    }
  }
}
export interface BridgeRequestOptions {
  /** Cancel optional presentation work when its owner is no longer active. */
  signal?: AbortSignal;
  /** Wait budget; bounded to REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Receives the reply's text so far while Claude CLI is still writing it. */
  onText?: (text: string) => void;
  /** Stop waiting once the request's owner is gone. */
  isActive?: () => boolean;
}
/** T describes the operation reply; domain callers still validate its contents. */
export async function bridgeRequest<T extends object = Record<string, unknown>>(
  operation: string,
  payload: unknown,
  options?: BridgeRequestOptions,
) {
  if (options?.isActive?.() === false)
    throw Error("Study session closed; saved work retained");
  const provider = status().mode;
  const requested = options?.timeoutMs;
  const budget =
    typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? Math.min(requested, REQUEST_TIMEOUT_MS)
      : REQUEST_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(
    provider === "claude-cli" ? budget : Math.min(budget, 45000),
  );
  const signal = options?.signal
    ? AbortSignal.any([timeout, options.signal])
    : timeout;
  const body = JSON.stringify({
    operation,
    payload,
    provider,
    ...(provider === "claude-cli" && options?.onText ? { stream: true } : {}),
  });
  const r = await fetch("/api/bridge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal,
  });
  if (
    options?.onText &&
    r.headers.get("Content-Type")?.includes("application/x-ndjson")
  )
    return (await readStream(r, options.onText)) as T;
  const data = await readJson(r);
  if (!r.ok)
    throw Error(
      typeof data.error === "string" ? data.error : "Bridge request failed",
    );
  return data as T;
}
