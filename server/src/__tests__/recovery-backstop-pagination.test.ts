import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRelations, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));
import { recoveryService } from "../services/recovery/service.js";

const support = await getEmbeddedPostgresTestSupport();
const integration = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Backstop pagination test unavailable: ${support.reason}`);

integration("resolved dependency backstop pagination", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-backstop-pagination-");
    db = createDb(temporary.connectionString);
  }, 20_000);
  afterAll(async () => { await temporary?.cleanup(); });

  it("eventually reaches an eligible issue after 500 non-ready candidates and wraps", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const ids = Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, "0")}`);
    await db.insert(companies).values({ id: companyId, name: "Pagination test", issuePrefix: "PAGE", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Test executor", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values(ids.map((id, i) => ({ id, companyId, title: `Candidate ${i + 1}`, status: "blocked", assigneeAgentId: agentId, issueNumber: i + 1, identifier: `PAGE-${i + 1}` })));
    await db.insert(issues).values({ id: blockerId, companyId, title: "Resolved dependency", status: "done", issueNumber: 502, identifier: "PAGE-502" });
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: ids[500], type: "blocks" });
    const enqueueWakeup = vi.fn(async () => (await db.insert(heartbeatRuns).values({ companyId, agentId, status: "queued", invocationSource: "automation" }).returning())[0]);
    const recovery = recoveryService(db, { enqueueWakeup });

    const first = await recovery.reconcileResolvedDependencyWakeBackstop({ companyId });
    expect(first).toMatchObject({ checked: 500, candidateLimitSkipped: 1, notReadySkipped: 500, healed: 0 });
    expect(enqueueWakeup).not.toHaveBeenCalled();
    const second = await recovery.reconcileResolvedDependencyWakeBackstop({ companyId });
    expect(second).toMatchObject({ checked: 1, candidateLimitSkipped: 0, healed: 1, enqueueFailed: 0, issueIds: [ids[500]] });
    expect(enqueueWakeup).toHaveBeenCalledExactlyOnceWith(agentId, expect.objectContaining({ reason: "issue_blockers_resolved", payload: expect.objectContaining({ issueId: ids[500] }) }));
    const third = await recovery.reconcileResolvedDependencyWakeBackstop({ companyId });
    expect(third).toMatchObject({ checked: 500, candidateLimitSkipped: 1, notReadySkipped: 500, healed: 0 });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });
});
