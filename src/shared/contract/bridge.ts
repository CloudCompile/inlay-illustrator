/**
 * Backend -> frontend fetch bridge for JSON.
 *
 * Some REST endpoints have no Spindle API yet (character gallery, LLM connection model lists). The backend asks the
 * frontend, which fetches them same-origin with the user's session. Image bytes do not use the bridge
 * (`spindle.images.readBinary`, src/backend/services/image-bytes.ts).
 * Transport: plain messages on the Spindle frontend/backend channel (not RPC envelopes).
 *
 * backend -> frontend  {@link FetchBridgeRequest}
 * frontend -> backend  {@link FetchBridgeResponse}   (exactly one per requestId; the backend times out after ~15 s)
 *
 * - Request: fetch the URL (GET, credentials same-origin, Accept: application/json), answer `{json}`.
 * - Errors: `{error: "<English message>", status?}`.
 * Only same-origin relative URLs starting with `/api/` are allowed (the frontend must refuse anything else).
 */
export const FETCH_BRIDGE_REQUEST = "inlay-illustrator:fetch-request";
export const FETCH_BRIDGE_RESPONSE = "inlay-illustrator:fetch-response";

export interface FetchBridgeRequest {
  type: typeof FETCH_BRIDGE_REQUEST;
  requestId: string;
  url: string;
}
export interface FetchBridgeResponse {
  type: typeof FETCH_BRIDGE_RESPONSE;
  requestId: string;
  json?: unknown;
  error?: string;
  status?: number;
}

export function isFetchBridgeRequest(value: unknown): value is FetchBridgeRequest {
  const v = value as Record<string, unknown> | null;
  return !!v && typeof v === "object" && v.type === FETCH_BRIDGE_REQUEST && typeof v.requestId === "string" && typeof v.url === "string";
}
export function isFetchBridgeResponse(value: unknown): value is FetchBridgeResponse {
  const v = value as Record<string, unknown> | null;
  return !!v && typeof v === "object" && v.type === FETCH_BRIDGE_RESPONSE && typeof v.requestId === "string";
}
/** Allowed bridge URL: same-origin API path, no scheme / protocol-relative / traversal. */
export function isAllowedBridgeUrl(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("/api/") && !url.startsWith("//") && !/\.\.(?:\/|$)/u.test(url) && !/[\s\\]/u.test(url);
}
