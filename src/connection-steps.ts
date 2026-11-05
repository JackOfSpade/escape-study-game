import type { BridgeStatus } from "./bridge-client";

export interface ConnectionStep {
  text: string;
  command?: string;
}
const OPEN_TERMINAL: ConnectionStep = {
  text: "Open the Terminal app on this computer.",
};
const SIGN_IN: ConnectionStep = {
  text: "Sign in to Claude and finish the login in your browser.",
  command: "claude auth login",
};
const INSTALL: ConnectionStep = {
  text: "Install Claude CLI.",
  command: "curl -fsSL https://claude.ai/install.sh | bash",
};
const START_RELAY: ConnectionStep = {
  text: "Go to the game's project folder and start the study relay.",
  command: "npm run bridge:start",
};
/** What the player must do to enable a terminal, for the actual cause. */
export function connectionSteps(status: BridgeStatus): {
  problem: string;
  steps: ConnectionStep[];
} {
  switch (status.reason) {
    case "cli-missing":
      return {
        problem: "Claude CLI is not installed on this computer.",
        steps: [OPEN_TERMINAL, INSTALL, SIGN_IN],
      };
    case "signed-out":
      return {
        problem: "Claude CLI is not signed in.",
        steps: [OPEN_TERMINAL, SIGN_IN],
      };
    default:
      return {
        problem: "The game cannot reach its study relay, which talks to Claude.",
        steps: [OPEN_TERMINAL, START_RELAY],
      };
  }
}
