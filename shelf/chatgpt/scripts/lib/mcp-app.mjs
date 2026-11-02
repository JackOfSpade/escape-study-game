import { sha256 } from "./digest.mjs";
import { isRecord as isObject } from "./is-record.mjs";

/** Boilerplate shared by the MCP App tool sets (live terminal relay and synthetic demo). */
export const MCP_APP_MIME = "text/html;profile=mcp-app";
export const OAUTH_HANDOFF = [{ type: "oauth2", scopes: ["handoff"] }];
/** A closed JSON Schema object; every property is required unless `required` is given. */
export const schema = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
export const idSchema = { type: "string", minLength: 1, maxLength: 100 };
export { sha256, isObject };
/** Non-empty text within the terminal reply bound. */
export const boundedText = (value, limit = 8000) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= limit;
/** Attach the handoff OAuth requirement to every tool descriptor. */
export const withHandoffAuth = (tools) =>
  tools.map((tool) => ({
    ...tool,
    securitySchemes: OAUTH_HANDOFF,
    _meta: { ...tool._meta, securitySchemes: OAUTH_HANDOFF },
  }));
/** The OAuth owner of a tool call; every app tool requires an authenticated game link. */
export function grantOwner(grant) {
  if (typeof grant?.linkId !== "string" || !grant.linkId)
    throw Error("Authenticated game connection required");
  return grant.linkId;
}
/** Reject unknown tools and arguments outside the descriptor's schema. */
export function checkToolArguments(tools, name, args) {
  if (!isObject(args)) throw Error("Expected tool arguments");
  const descriptor = tools.find((t) => t.name === name);
  if (
    !descriptor ||
    Object.keys(args).some((k) => !(k in descriptor.inputSchema.properties))
  )
    throw Error("Unknown terminal tool or argument");
  return descriptor;
}
/** A single HTML UI resource with the MCP App metadata both apps use. */
export const uiResource = (uri, text, widgetDescription) => ({
  contents: [
    {
      uri,
      mimeType: MCP_APP_MIME,
      text,
      _meta: {
        ui: {
          prefersBorder: true,
          csp: { connectDomains: [], resourceDomains: [] },
        },
        "openai/widgetDescription": widgetDescription,
        "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] },
      },
    },
  ],
});
