import { describe, expect, test } from "bun:test";
import { createFakeHost } from "../testing/fake-host.js";
import { createDecisionService } from "./decisions.js";
import { createRunLog } from "./run-log.js";
import { createEventBus } from "./events.js";

describe("DecisionService", () => {
  test("listConnections maps profiles from host.decisions with userId", async () => {
    const fake = createFakeHost({ userId: "test-user-123" });
    fake.decisionConnections = [
      {
        id: "dec-1",
        name: "TypeSafe Main",
        provider: "typesafe",
        model: "typesafe/jev-latest",
        api_url: "https://api.typesafe.ai/v1",
        is_default: true,
        has_api_key: true,
        default_parameters: {},
        metadata: {},
        created_at: 1000,
        updated_at: 1000,
      },
    ];
    let capturedOptions: any = null;
    (fake.host.decisions as any).listConnections = async (opts: any) => {
      capturedOptions = opts;
      return fake.decisionConnections;
    };
    const log = createRunLog({ events: createEventBus(fake.host, fake.userId), host: fake.host });
    const svc = createDecisionService(fake.host, log, fake.userId);

    const list = await svc.listConnections();
    expect(list).toEqual([
      {
        id: "dec-1",
        name: "TypeSafe Main",
        provider: "typesafe",
        model: "typesafe/jev-latest",
        isDefault: true,
        hasApiKey: true,
      },
    ]);
    expect(capturedOptions).toEqual({ userId: "test-user-123" });
  });

  test("testConnection evaluates a ping question passing userId", async () => {
    const fake = createFakeHost({ userId: "test-user-456" });
    let capturedInput: any = null;
    (fake.host.decisions as any).evaluate = async (input: any) => {
      capturedInput = input;
      return { model: input.model, answers: { test: { type: "noul", noul: 1 } } };
    };
    const log = createRunLog({ events: createEventBus(fake.host, fake.userId), host: fake.host });
    const svc = createDecisionService(fake.host, log, fake.userId);

    const result = await svc.testConnection({ connectionId: "dec-1", model: "typesafe/jev-latest" });
    expect(result.ok).toBe(true);
    expect(result.model).toBe("typesafe/jev-latest");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(capturedInput.userId).toBe("test-user-456");
  });

  test("createJevAdapter answers the TypeSafe systemone request through host.decisions with userId", async () => {
    const fake = createFakeHost({ userId: "test-user-789" });
    let capturedInput: any = null;
    (fake.host.decisions as any).evaluate = async (input: any) => {
      capturedInput = input;
      return { model: input.model, answers: { q1: { type: "noul", noul: 1 } }, usage: { input_tokens: 3, output_tokens: 1 } };
    };
    const log = createRunLog({ events: createEventBus(fake.host, fake.userId), host: fake.host });
    const svc = createDecisionService(fake.host, log, fake.userId);

    const adapter = svc.createJevAdapter(() => ({ connectionId: "dec-1", model: "typesafe/jev-latest", rosterSelectionDefault: true }));
    expect(adapter.getConfig().apiKey).toBe("lumiverse");
    const res = await adapter.network.fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {},
      body: JSON.stringify({ model: "typesafe/jev-latest", state: "story text", questions: { q1: { type: "noul", instructions: "Present?" } } }),
    });
    expect(await res.json()).toEqual({ model: "typesafe/jev-latest", answers: { q1: { type: "noul", noul: 1 } }, usage: { input_tokens: 3, output_tokens: 1 } });
    expect(capturedInput).toMatchObject({ connection_id: "dec-1", model: "typesafe/jev-latest", userId: "test-user-789" });
  });
});
