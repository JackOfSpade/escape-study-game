export declare const CATASTROPHE_ENUMS: Readonly<{
  silhouettes: readonly string[];
  doors: readonly string[];
  spawns: readonly string[];
  media: readonly string[];
  triggers: readonly string[];
  effects: readonly string[];
  warnings: readonly string[];
  collapseTargets: readonly string[];
  phases: readonly string[];
  omenEffects: readonly string[];
}>;

/** JSON Schema for one `escape-catastrophe` reply, built from its payload. */
export declare function catastropheReplySchema(payload: unknown): {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
};
