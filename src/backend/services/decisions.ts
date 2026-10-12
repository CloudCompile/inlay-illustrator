/**
 * DecisionService over Lumiverse decision connections (`spindle.decisions`).
 */
import type { SpindleHost, RunLog } from "./types.js";
import { rpcError, type DecisionConnectionSummary, type ModelOption, type RpcError } from "../../shared/contract/index.js";
import type { JevConnectionSettings } from "../../shared/contract/config.js";

export interface DecisionTestResult {
  ok: boolean;
  latencyMs: number;
  model?: string;
  error?: RpcError;
}

export interface DecisionTestParams {
  connectionId?: string;
  model?: string;
  userId?: string;
}

export interface DecisionServiceOptions {
  userId?: string;
}

export interface DecisionService {
  listConnections(options?: DecisionServiceOptions): Promise<DecisionConnectionSummary[]>;
  listModels(connectionId: string, options?: DecisionServiceOptions): Promise<ModelOption[]>;
  testConnection(params: DecisionTestParams, options?: { signal?: AbortSignal }): Promise<DecisionTestResult>;
  createJevAdapter(getConfig: () => JevConnectionSettings, options?: DecisionServiceOptions): {
    network: {
      evaluate(
        connection: { apiKey?: string; model: string; connectionId?: string; userId?: string },
        request: { state: unknown; questions: Record<string, unknown> },
        options?: { signal?: AbortSignal; timeoutMs?: number },
      ): Promise<{
        model: string;
        answers: Record<string, unknown>;
        latencyMs: number;
        usage?: { inputTokens?: number; outputTokens?: number };
      }>;
    };
    getConfig: () => JevConnectionSettings;
  };
}

export function createDecisionService(host: SpindleHost, log: RunLog, defaultUserId?: string): DecisionService {
  return {
    async listConnections(options = {}): Promise<DecisionConnectionSummary[]> {
      const api = (host as any).decisions;
      if (!api?.listConnections) return [];
      const effectiveUserId = options.userId ?? defaultUserId;
      try {
        const list = await api.listConnections(effectiveUserId ? { userId: effectiveUserId } : undefined);
        return list.map((c: any) => ({
          id: c.id,
          name: c.name,
          provider: c.provider,
          model: c.model,
          isDefault: !!c.is_default,
          hasApiKey: !!c.has_api_key,
        }));
      } catch (err) {
        log.append("error", "decision", `Failed to list decision connections: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    },

    async listModels(connectionId: string, options = {}): Promise<ModelOption[]> {
      const api = (host as any).decisions;
      if (!api?.getModels) return [];
      const effectiveUserId = options.userId ?? defaultUserId;
      try {
        const models = await api.getModels(connectionId, effectiveUserId ? { userId: effectiveUserId } : undefined);
        return models.map((m: any) => ({
          id: m.id,
          label: m.label || m.id,
          description: m.description,
        }));
      } catch (err) {
        log.append("error", "decision", `Failed to list decision models: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    },

    async testConnection(params, options = {}): Promise<DecisionTestResult> {
      const api = (host as any).decisions;
      if (!api?.evaluate) {
        return {
          ok: false,
          latencyMs: 0,
          error: rpcError("unsupported", "Decision API is not supported on this Lumiverse host."),
        };
      }
      const effectiveUserId = params.userId ?? defaultUserId;
      const start = Date.now();
      try {
        const res = await api.evaluate(
          {
            connection_id: params.connectionId || undefined,
            model: params.model || undefined,
            state: "Inlay decision connection test",
            questions: {
              test: {
                type: "noul",
                instructions: "Is this connection test functioning?",
              },
            },
            ...(effectiveUserId ? { userId: effectiveUserId } : {}),
          },
          { signal: options.signal },
        );
        return {
          ok: true,
          latencyMs: Date.now() - start,
          model: res.model,
        };
      } catch (err) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          error: rpcError("provider-error", err instanceof Error ? err.message : String(err)),
        };
      }
    },

    createJevAdapter(getConfig, adapterOptions = {}) {
      return {
        network: {
          async evaluate(connection, request, options = {}) {
            const api = (host as any).decisions;
            if (!api?.evaluate) {
              throw new Error("JEV_UNAVAILABLE: Lumiverse decisions API is not available on this host.");
            }
            const currentCfg = getConfig();
            const targetModel = connection.model || currentCfg.model || "jev-latest";
            const connId = connection.connectionId || currentCfg.connectionId || undefined;
            const effectiveUserId = connection.userId ?? adapterOptions.userId ?? defaultUserId;
            const start = Date.now();
            const res = await api.evaluate(
              {
                connection_id: connId,
                model: targetModel,
                state: request.state as any,
                questions: request.questions as any,
                ...(effectiveUserId ? { userId: effectiveUserId } : {}),
              },
              { signal: options.signal },
            );
            return {
              model: res.model,
              answers: res.answers,
              latencyMs: Date.now() - start,
              usage: {
                inputTokens: (res.usage?.input_tokens as number) ?? 0,
                outputTokens: (res.usage?.output_tokens as number) ?? 0,
              },
            };
          },
        },
        getConfig,
      };
    },
  };
}
