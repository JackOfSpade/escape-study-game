// Retired: the workspace followed Encounter.directStudy (the ChatGPT direct
// study session) to keep a consumed NPC lock resumable. Not built here.
test("a human native session on a consumed NPC lock remains resumable for learning", () => {
  const g = createPlayableGame(130, r);
  enterStudyWorkspace(g);
  const npc = Object.values(g.encounters)[0];
  npc.state = "consumed";
  npc.owner = "npc-only";
  npc.directStudy = {
    id: "synthetic-human-session",
    createdAt: 1,
    provider: "chatgpt-handoff",
    payloadJson: "{}",
    questionFingerprint: "synthetic-fingerprint",
    state: "pending",
  };
  assert.equal(workspaceQuestion(g), npc);
  assert.equal(nextWorkspaceQuestion(g, r), npc);
  assert.equal(workspaceSelectedQuestion(g), npc);
  npc.directStudy.state = "applied";
  assert.equal(workspaceQuestion(g), undefined);
});
