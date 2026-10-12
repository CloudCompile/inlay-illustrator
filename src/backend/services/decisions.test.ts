import { describe, expect, test } from "bun:test";
import { createFakeHost } from "../testing/fake-host.js";
import { createDecisionService } from "./decisions.js";
import { createRunLog } from "./run-log.js";
import { createEventBus } from "./events.js";

describe("DecisionService", () => {
  test("listConnections maps profiles from host.decisions", async () => {
    const fake = createFakeHost();
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
    const log = createRunLog({ events: createEventBus(fake.host, fake.userId), host: fake.host });
    const svc = createDecisionService(fake.host, log);

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
  });

  test("testConnection evaluates a ping question", async () => {
    const fake = createFakeHost();
    const log = createRunLog({ events: createEventBus(fake.host, fake.userId), host: fake.host });
    const svc = createDecisionService(fake.host, log);

    const result = await svc.testConnection({ connectionId: "dec-1", model: "typesafe/jev-latest" });
    expect(result.ok).toBe(true);
    expect(result.model).toBe("typesafe/jev-latest");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("createJevAdapter provides network evaluate for Qht", async () => {
    const fake = createFakeHost();
    const log = createRunLog({ events: createEventBus(fake.host, fake.userId), host: fake.host });
    const svc = createDecisionService(fake.host, log);

    const adapter = svc.createJevAdapter(() => ({ connectionId: "dec-1", model: "typesafe/jev-latest", rosterSelectionDefault: true }));
    const evalRes = await adapter.network.evaluate(
      { model: "typesafe/jev-latest", connectionId: "dec-1" },
      { state: "story text", questions: { q1: { type: "noul", instructions: "Present?" } } }
    );
    expect(evalRes.model).toBe("typesafe/jev-latest");
    expect(evalRes.answers.q1).toEqual({ type: "noul", noul: 0.95 });
  });
});
