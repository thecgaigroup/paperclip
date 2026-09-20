import { afterEach, describe, expect, it, vi } from "vitest";

let heartbeat: typeof import("../services/heartbeat.ts") | undefined;
afterEach(() => {
  heartbeat?.stopTaskDrain();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("startup task drain", () => {
  it("holds admission before any API request and can be released without restarting", async () => {
    vi.stubEnv("PAPERCLIP_START_IN_TASK_DRAIN", "true");
    vi.resetModules();
    heartbeat = await import("../services/heartbeat.ts");
    expect(heartbeat.getTaskDrainStatus()).toMatchObject({
      draining: true,
      expiresAt: null,
      activeRuns: 0,
      pendingWakes: 0,
      quiescent: true,
    });
    expect(heartbeat.resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: true,
      reason: "task_drain",
    });
    expect(heartbeat.stopTaskDrain()).toEqual({ wasActive: true });
    // The startup flag is one-shot, not an admission override that reasserts.
    expect(process.env.PAPERCLIP_START_IN_TASK_DRAIN).toBe("true");
    expect(heartbeat.resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: false,
      reason: null,
    });
  });

  it.each([undefined, "false"])("preserves ordinary startup when flag is %s", async (value) => {
    vi.stubEnv("PAPERCLIP_START_IN_TASK_DRAIN", value);
    vi.resetModules();
    heartbeat = await import("../services/heartbeat.ts");
    expect(heartbeat.getTaskDrainStatus().draining).toBe(false);
  });
});
