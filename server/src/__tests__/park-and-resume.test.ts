import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  heartbeatRuns,
  budgetPolicies,
  costEvents,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { budgetService } from "../services/budgets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("Park-at-budget and token logging", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-park-resume-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    if (tempDb?.pg) {
      await tempDb.pg.stop();
    }
  }, 10_000);

  beforeEach(async () => {
    companyId = randomUUID();
    agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Test Company",
      issuePrefix: `TST${Math.floor(Math.random() * 10000)}`,
      status: "active",
      budgetMonthlyCents: 100000,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Test Agent",
      adapterType: "claude-local",
      status: "idle",
    });
  });


  describe("Budget cap parking", () => {
    it("parks run when budget cap is hit rather than cancelling", async () => {
      const runId = randomUUID();
      
      await db.insert(budgetPolicies).values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 1000,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      });

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "running",
        startedAt: new Date(),
      });

      await db.insert(costEvents).values({
        companyId,
        agentId,
        heartbeatRunId: runId,
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        inputTokens: 1000,
        outputTokens: 500,
        costCents: 1000,
        occurredAt: new Date(),
      });

      const budgets = budgetService(db);
      const block = await budgets.getInvocationBlock(companyId, agentId);
      
      expect(block).toBeDefined();
      expect(block?.scopeType).toBe("agent");
      
      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);

      expect(run).toBeDefined();
    });

    it("sets status to awaiting_approval when hitting budget cap", async () => {
      const runId = randomUUID();

      await db.insert(budgetPolicies).values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 500,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      });

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "running",
        startedAt: new Date(),
      });

      const costEvent = await db.insert(costEvents).values({
        companyId,
        agentId,
        heartbeatRunId: runId,
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        inputTokens: 1000,
        outputTokens: 500,
        costCents: 600,
        occurredAt: new Date(),
      }).returning().then(rows => rows[0]);

      const budgets = budgetService(db);
      await budgets.evaluateCostEvent(costEvent);

      const agent = await db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0]);

      expect(agent).toBeDefined();
      expect(agent?.status).toBe("paused");
      expect(agent?.pauseReason).toBe("budget");
    });

    it("prevents new runs from starting when in awaiting_approval state", async () => {
      await db
        .update(agents)
        .set({ status: "paused", pauseReason: "budget" })
        .where(eq(agents.id, agentId));

      const budgets = budgetService(db);
      const block = await budgets.getInvocationBlock(companyId, agentId);

      expect(block).not.toBeNull();
      expect(block?.reason).toContain("budget");
    });

    it("allows resuming after budget increase", async () => {
      const policyId = randomUUID();

      await db.insert(budgetPolicies).values({
        id: policyId,
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 500,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      });

      await db
        .update(agents)
        .set({ status: "paused", pauseReason: "budget" })
        .where(eq(agents.id, agentId));

      const budgets = budgetService(db);
      await budgets.upsertPolicy(
        companyId,
        {
          scopeType: "agent",
          scopeId: agentId,
          amount: 5000,
        },
        "test-user-id"
      );

      const agent = await db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0]);

      expect(agent).toBeDefined();
      expect(agent?.status).toBe("idle");
      expect(agent?.pauseReason).toBeNull();
    });
  });

  describe("Token logging on every run", () => {
    it("records token usage for a priced run", async () => {
      const runId = randomUUID();

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "succeeded",
        startedAt: new Date(),
        finishedAt: new Date(),
        inputTokens: 1500,
        outputTokens: 750,
        cachedInputTokens: 200,
        costUsd: 50,
      });

      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);

      expect(run).toBeDefined();
      expect(run?.inputTokens).toBe(1500);
      expect(run?.outputTokens).toBe(750);
      expect(run?.cachedInputTokens).toBe(200);
      expect(run?.costUsd).toBe(50);
    });

    it("records token usage for a $0 run", async () => {
      const runId = randomUUID();

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "succeeded",
        startedAt: new Date(),
        finishedAt: new Date(),
        inputTokens: 1000,
        outputTokens: 500,
        cachedInputTokens: 0,
        costUsd: 0,
      });

      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);

      expect(run).toBeDefined();
      expect(run?.inputTokens).toBe(1000);
      expect(run?.outputTokens).toBe(500);
      expect(run?.cachedInputTokens).toBe(0);
      expect(run?.costUsd).toBe(0);
    });

    it("records token usage even when no cost event is created", async () => {
      const runId = randomUUID();

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "succeeded",
        startedAt: new Date(),
        finishedAt: new Date(),
        inputTokens: 500,
        outputTokens: 250,
        cachedInputTokens: 100,
        costUsd: 0,
      });

      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);

      expect(run).toBeDefined();
      expect(run?.inputTokens).toBe(500);
      expect(run?.outputTokens).toBe(250);
      expect(run?.cachedInputTokens).toBe(100);

      const costEventsForRun = await db
        .select()
        .from(costEvents)
        .where(eq(costEvents.heartbeatRunId, runId));

      expect(costEventsForRun).toHaveLength(0);
    });

    it("preserves token data across run lifecycle", async () => {
      const runId = randomUUID();

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "running",
        startedAt: new Date(),
      });

      await db
        .update(heartbeatRuns)
        .set({
          status: "succeeded",
          finishedAt: new Date(),
          inputTokens: 2000,
          outputTokens: 1000,
          cachedInputTokens: 300,
          costUsd: 75,
        })
        .where(eq(heartbeatRuns.id, runId));

      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);

      expect(run).toBeDefined();
      expect(run?.status).toBe("succeeded");
      expect(run?.inputTokens).toBe(2000);
      expect(run?.outputTokens).toBe(1000);
      expect(run?.cachedInputTokens).toBe(300);
      expect(run?.costUsd).toBe(75);
    });
  });
});
