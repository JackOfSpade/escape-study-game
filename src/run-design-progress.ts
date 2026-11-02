export type RunDesignStage = "design" | "details" | "review";

/** Activity reflects a request the model is working on or real local checks. */
export interface RunDesignActivity {
  stage: RunDesignStage;
  state: "working" | "checking";
  detail: string;
}
