/**
 * Frontend side of the backend fetch bridge (src/shared/contract/bridge.ts): fetches same-origin `/api/...`
 * JSON with the user's session and answers exactly once per request.
 */
import {
  FETCH_BRIDGE_RESPONSE,
  isAllowedBridgeUrl,
  type FetchBridgeRequest,
  type FetchBridgeResponse
} from "../shared/contract/bridge.js";

/** Runs one bridge request. Never throws: errors become `{error}` responses. */
export async function answerFetchBridge(request: FetchBridgeRequest, fetcher: typeof fetch = fetch): Promise<FetchBridgeResponse> {
  const base = { type: FETCH_BRIDGE_RESPONSE, requestId: request.requestId } as const;
  if (!isAllowedBridgeUrl(request.url)) return { ...base, error: "URL not allowed (only same-origin /api/ paths)." };
  try {
    const response = await fetcher(request.url, { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!response.ok) return { ...base, error: `HTTP ${response.status}`, status: response.status };
    return { ...base, json: await response.json(), status: response.status };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}
