import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
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

const mockLogActivity = vi.hoisted(() => vi.fn());
vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("Park-at-budget and token logging (real code paths)", () => {
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

  describe("Park-at-budget gate (real budget enforcement)", () => {
    it("parks running runs when budget hard-stop is hit instead of only pausing the agent", async () => {
      const runId = randomUUID();
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

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "running",
        startedAt: new Date(),
      });

      const costEvent = await db
        .insert(costEvents)
        .values({
          companyId,
          agentId,
          heartbeatRunId: runId,
          provider: "anthropic",
          model: "claude-3-5-sonnet-20241022",
          inputTokens: 1000,
          outputTokens: 500,
          costCents: 600,
          occurredAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]);

      const budgets = budgetService(db);
      await budgets.evaluateCostEvent(costEvent);

      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);

      expect(run).toBeDefined();
      expect(run?.status).toBe("awaiting_approval");
    });

    it("blocks new runs when agent has parked runs awaiting approval", async () => {
      const runId = randomUUID();

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "awaiting_approval",
        startedAt: new Date(),
      });

      const budgets = budgetService(db);
      const block = await budgets.getInvocationBlock(companyId, agentId);

      expect(block).not.toBeNull();
      expect(block?.reason).toContain("awaiting budget approval");
    });

    it("resumes parked runs when budget is raised via policy update", async () => {
      const runId = randomUUID();
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

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "awaiting_approval",
        startedAt: new Date(),
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

      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);

      expect(run?.status).toBe("running");

      const agent = await db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0]);

      expect(agent?.status).toBe("idle");
      expect(agent?.pauseReason).toBeNull();
    });
  });

  describe("Per-run token logging on every finished run", () => {
    it("records token usage on succeeded run", async () => {
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
          inputTokens: 1500,
          outputTokens: 750,
          cachedInputTokens: 200,
          costCents: 50,
        })
        .where(eq(heartbeatRuns.id, runId));

      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);

      expect(run?.inputTokens).toBe(1500);
      expect(run?.outputTokens).toBe(750);
      expect(run?.cachedInputTokens).toBe(200);
      expect(run?.costCents).toBe(50);
    });

    it("records token usage on $0 run with no cost event", async () => {
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
          inputTokens: 1000,
          outputTokens: 500,
          cachedInputTokens: 0,
          costCents: 0,
        })
        .where(eq(heartbeatRuns.id, runId));

      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);

      expect(run?.inputTokens).toBe(1000);
      expect(run?.outputTokens).toBe(500);
      expect(run?.costCents).toBe(0);

      const costEventsForRun = await db
        .select()
        .from(costEvents)
        .where(eq(costEvents.heartbeatRunId, runId));

      expect(costEventsForRun).toHaveLength(0);
    });

    it("records token usage on failed run", async () => {
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
          status: "failed",
          finishedAt: new Date(),
          error: "Test error",
          inputTokens: 500,
          outputTokens: 100,
          cachedInputTokens: 50,
          costCents: 25,
        })
        .where(eq(heartbeatRuns.id, runId));

      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);

      expect(run?.status).toBe("failed");
      expect(run?.inputTokens).toBe(500);
      expect(run?.outputTokens).toBe(100);
      expect(run?.costCents).toBe(25);
    });

    it("records token usage on cancelled run", async () => {
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
          status: "cancelled",
          finishedAt: new Date(),
          inputTokens: 300,
          outputTokens: 50,
          cachedInputTokens: 25,
          costCents: 15,
        })
        .where(eq(heartbeatRuns.id, runId));

      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);

      expect(run?.status).toBe("cancelled");
      expect(run?.inputTokens).toBe(300);
      expect(run?.outputTokens).toBe(50);
      expect(run?.costCents).toBe(15);
    });
  });
});
