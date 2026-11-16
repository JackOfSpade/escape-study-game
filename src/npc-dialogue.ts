import {
  buildNpcDialogueReview,
  isNpcDialogueContext,
  parseNpcDialogueDraft,
  parseNpcDialogueReview,
  type DialogueReviewRequest,
} from "../scripts/lib/npc-dialogue-policy.mjs";
import type { NpcChatterReply, NpcChatterRequest } from "./npc-chatter";

export interface NpcDialogueTransport {
  generate(
    request: NpcChatterRequest,
    signal: AbortSignal,
    isActive: () => boolean,
  ): Promise<unknown>;
  review(
    request: DialogueReviewRequest<NpcChatterRequest>,
    signal: AbortSignal,
    isActive: () => boolean,
  ): Promise<unknown>;
}
interface NpcDialogueControls {
  signal: AbortSignal;
  isActive: () => boolean;
  onEvidence?: (request: NpcChatterRequest, ids: readonly string[]) => void;
  isEvidenceCurrent?: (
    request: NpcChatterRequest,
    ids: readonly string[],
  ) => boolean;
}

/** The model chooses the line or silence. A separate critic must approve the
 * exact candidate before speech. One repair is allowed, within the caller's
 * single cancellation/deadline budget; there is no canned fallback. */
export async function generateNpcDialogue(
  original: NpcChatterRequest,
  transport: NpcDialogueTransport,
  controls: NpcDialogueControls,
): Promise<NpcChatterReply | undefined> {
  if (!isNpcDialogueContext(original))
    throw Error("NPC dialogue needs a grounded context");
  let request = structuredClone(original);
  const live = () => !controls.signal.aborted && controls.isActive();
  for (const attempt of [0, 1] as const) {
    if (!live()) return;
    const candidate = parseNpcDialogueDraft(
      request,
      await transport.generate(request, controls.signal, live),
    );
    if (!live() || candidate.decision === "silent") return;
    controls.onEvidence?.(request, candidate.evidence);
    const current = () =>
      live() &&
      (controls.isEvidenceCurrent?.(request, candidate.evidence) ?? true);
    if (!current()) return;
    const packet = await buildNpcDialogueReview(request, candidate, attempt);
    if (!current()) return;
    const critique = parseNpcDialogueReview(
      packet,
      await transport.review(packet, controls.signal, current),
    );
    if (!current()) return;
    if (critique.verdict === "accept")
      return {
        requestId: candidate.requestId,
        actorId: candidate.actorId,
        text: candidate.text,
        ...(candidate.delivery ? { delivery: candidate.delivery } : {}),
        ...(candidate.conversation
          ? { conversation: candidate.conversation }
          : {}),
      };
    if (critique.verdict === "silence" || attempt === 1) return;
    request = {
      ...structuredClone(original),
      requestId: `${original.requestId}-repair-1`,
      dialogue: {
        ...structuredClone(original.dialogue!),
        feedback: {
          previousText: candidate.text,
          issues: [...critique.issues],
          note: critique.note,
        },
      },
    };
  }
  return undefined;
}
