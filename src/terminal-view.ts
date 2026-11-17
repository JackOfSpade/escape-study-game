import type { Encounter } from "./model";
export function submissionView(e: Encounter) {
  const s = e.submissions.at(-1);
  if (s?.status === "pending")
    return {
      label: "Checking answer…",
      tone: "pending",
      help: "Your submitted answer is being reviewed. You can keep editing or ask for help.",
    };
  if (s?.status === "error")
    return {
      label: "Unable to check",
      tone: "error",
      help: "No verdict yet. Your answer is saved. Check the AI connection in Settings, then retry.",
    };
  if (s?.status === "complete")
    return {
      label:
        s.completionRequest || s.dialogueRequestId
          ? "Accepted"
          : "Completed previously",
      tone: "accepted",
      help: "This question is solved. Individual learning assessment is separate.",
    };
  if (s?.status === "needs-work")
    return {
      label: "Not accepted",
      tone: "rejected",
      help:
        s.revision === e.revision
          ? "Revise your answer and submit again. Ask in chat if you need help."
          : "You have edited the answer since this check. Submit it again when ready.",
    };
  if (e.state === "consumed")
    return {
      label: "Completed",
      tone: "accepted",
      help: "This question is closed and read-only.",
    };
  return {
    label: "Not submitted",
    tone: "idle",
    help: "Write your answer above, then select Submit answer. Chat messages are not submissions.",
  };
}
