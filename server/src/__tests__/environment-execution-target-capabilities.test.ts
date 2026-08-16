import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveEnvironmentDriverConfigForRuntime } = vi.hoisted(() => ({
  mockResolveEnvironmentDriverConfigForRuntime: vi.fn(),
}));

vi.mock("../services/environment-config.js", () => ({
  resolveEnvironmentDriverConfigForRuntime: mockResolveEnvironmentDriverConfigForRuntime,
}));

import type { EffectiveSandboxCapabilities } from "@paperclipai/adapter-utils/execution-target";
import { resolveEnvironmentExecutionTarget } from "../services/environment-execution-target.js";
import type { EnvironmentRuntimeService } from "../services/environment-runtime.js";

const SNAPSHOT: EffectiveSandboxCapabilities = {
  reusableLeases: true,
  nativeSyncIn: true,
  nativeSyncOut: false,
  concurrentSyncAndExec: false,
  concurrentSyncOperations: false,
  persistentProcessSessions: true,
  independentControlCommands: false,
};

describe("resolveEnvironmentExecutionTarget effective capability snapshot", () => {
  beforeEach(() => {
    mockResolveEnvironmentDriverConfigForRuntime.mockReset();
  });

  it("test_execution_target_carries_read_only_effective_snapshot", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: { provider: "daytona", reuseLease: true, timeoutMs: 30_000 },
    });

    const effectiveSandboxCapabilities = vi.fn(async () => Object.freeze({ ...SNAPSHOT }));
    const environmentRuntime = {
      supportsSync: () => false,
      effectiveSandboxCapabilities,
    } as unknown as EnvironmentRuntimeService;

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: { id: "env-1", driver: "sandbox", config: { provider: "daytona" } },
      leaseId: "lease-1",
      leaseMetadata: { remoteCwd: "/work" },
      lease: { id: "lease-1", leasePolicy: "reuse_by_environment" } as never,
      environmentRuntime,
    });

    expect(target?.kind).toBe("remote");
    if (target?.kind !== "remote" || target.transport !== "sandbox") {
      throw new Error("expected a sandbox target");
    }
    expect(effectiveSandboxCapabilities).toHaveBeenCalledTimes(1);
    expect(target.effectiveCapabilities).toEqual(SNAPSHOT);

    // The snapshot is read-only: it is frozen, so a write does not change it.
    expect(Object.isFrozen(target.effectiveCapabilities)).toBe(true);
    const snapshot = target.effectiveCapabilities as EffectiveSandboxCapabilities;
    try {
      (snapshot as { reusableLeases: boolean }).reusableLeases = false;
    } catch {
      // A strict-mode assignment throws; a non-strict one is a silent no-op.
    }
    expect(snapshot.reusableLeases).toBe(true);
  });

  it("omits the snapshot when no environment runtime resolves it", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: { provider: "daytona", reuseLease: false, timeoutMs: 30_000 },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: { id: "env-1", driver: "sandbox", config: { provider: "daytona" } },
      leaseId: "lease-1",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });

    expect(target?.kind).toBe("remote");
    if (target?.kind !== "remote" || target.transport !== "sandbox") {
      throw new Error("expected a sandbox target");
    }
    expect(target.effectiveCapabilities).toBeUndefined();
  });
});
