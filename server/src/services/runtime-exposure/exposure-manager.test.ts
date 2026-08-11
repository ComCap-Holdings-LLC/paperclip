import { describe, expect, it } from "vitest";

import { RUNTIME_EXPOSURE_APP_PORT_MIN, deriveViteHmrPort } from "@paperclipai/shared";

import {
  BrokerClientError,
  type BrokerClient,
  type BrokerExposeResult,
  type BrokerListenerRequest,
  type BrokerOwnedListener,
  type BrokerRemoveResult,
} from "./broker-client.js";
import {
  deprovisionExposure,
  provisionExposure,
  reconcileExposures,
  type ExposureManagerDeps,
} from "./exposure-manager.js";

const RUNTIME_ID = "11111111-2222-4333-8444-555566667777";
const APP_PORT = RUNTIME_EXPOSURE_APP_PORT_MIN;
const HMR_PORT = deriveViteHmrPort(APP_PORT);
const HOSTNAME = "runner-abc.tail-scale.ts.net";

const CONFIG = {
  type: "tailscale_https" as const,
  hostname: "auto" as const,
  publicPort: "same" as const,
  includePaperclipViteHmr: true,
  failurePolicy: "fail_closed" as const,
};

interface FakeBrokerScript {
  expose?: (runtimeId: string, listeners: BrokerListenerRequest[]) => BrokerExposeResult;
  remove?: (runtimeId: string, handle: string) => BrokerRemoveResult;
  list?: () => BrokerOwnedListener[];
}

interface FakeBrokerCalls {
  expose: Array<{ runtimeId: string; listeners: BrokerListenerRequest[] }>;
  remove: Array<{ runtimeId: string; handle: string }>;
  list: number;
}

function fakeBroker(script: FakeBrokerScript): { broker: BrokerClient; calls: FakeBrokerCalls } {
  const calls: FakeBrokerCalls = { expose: [], remove: [], list: 0 };
  const broker: BrokerClient = {
    async expose(runtimeId, listeners) {
      calls.expose.push({ runtimeId, listeners });
      if (!script.expose) throw new BrokerClientError("internal_error", "no expose script");
      return script.expose(runtimeId, listeners);
    },
    async remove(runtimeId, handle) {
      calls.remove.push({ runtimeId, handle });
      if (!script.remove) throw new BrokerClientError("internal_error", "no remove script");
      return script.remove(runtimeId, handle);
    },
    async list() {
      calls.list += 1;
      return script.list ? script.list() : [];
    },
  };
  return { broker, calls };
}

function deps(broker: BrokerClient, probeHealth: () => Promise<boolean>): ExposureManagerDeps {
  return { broker, probeHealth, now: () => "2026-08-11T00:00:00.000Z" };
}

describe("provisionExposure", () => {
  it("exposes app + HMR and reports ready once the HTTPS probe validates", async () => {
    const { broker, calls } = fakeBroker({
      expose: () => ({ handle: "handle-abcdef1234567890", publicPorts: [APP_PORT, HMR_PORT] }),
    });
    const { status, handle } = await provisionExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      config: CONFIG,
      hostname: HOSTNAME,
      appPort: APP_PORT,
    });

    expect(calls.expose).toHaveLength(1);
    expect(calls.expose[0].listeners).toEqual([
      { purpose: "app", port: APP_PORT },
      { purpose: "vite_hmr", port: HMR_PORT },
    ]);
    expect(status.state).toBe("ready");
    expect(status.publicUrl).toBe(`https://${HOSTNAME}:${APP_PORT}`);
    expect(status.hostname).toBe(HOSTNAME);
    expect(status.listeners).toHaveLength(2);
    expect(status.brokerRef).toBe(RUNTIME_ID);
    expect(status.lastError).toBeNull();
    expect(handle).toBe("handle-abcdef1234567890");
  });

  it("omits the HMR listener when HMR is not requested", async () => {
    const { broker, calls } = fakeBroker({
      expose: () => ({ handle: "handle-abcdef1234567890", publicPorts: [APP_PORT] }),
    });
    const { status } = await provisionExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      config: { ...CONFIG, includePaperclipViteHmr: false },
      hostname: HOSTNAME,
      appPort: APP_PORT,
    });
    expect(calls.expose[0].listeners).toEqual([{ purpose: "app", port: APP_PORT }]);
    expect(status.listeners).toEqual([{ purpose: "app", publicPort: APP_PORT, targetPort: APP_PORT }]);
    expect(status.state).toBe("ready");
  });

  it("fails closed without calling the broker when the app port is out of range", async () => {
    const { broker, calls } = fakeBroker({});
    const { status, handle } = await provisionExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      config: CONFIG,
      hostname: HOSTNAME,
      appPort: 3100, // primary app port — never eligible
    });
    expect(calls.expose).toHaveLength(0);
    expect(status.state).toBe("failed");
    expect(handle).toBeNull();
  });

  it("fails when the broker rejects the expose request", async () => {
    const { broker } = fakeBroker({
      expose: () => {
        throw new BrokerClientError("port_not_allowlisted", "denied");
      },
    });
    const { status, handle } = await provisionExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      config: CONFIG,
      hostname: HOSTNAME,
      appPort: APP_PORT,
    });
    expect(status.state).toBe("failed");
    expect(status.lastError).toBe("port_not_allowlisted");
    expect(status.listeners).toEqual([]);
    expect(handle).toBeNull();
  });

  it("tears the mapping back down and fails when returned ports do not match", async () => {
    const { broker, calls } = fakeBroker({
      expose: () => ({ handle: "handle-abcdef1234567890", publicPorts: [APP_PORT] }), // missing HMR
      remove: () => ({ removedPorts: [APP_PORT] }),
    });
    const { status, handle } = await provisionExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      config: CONFIG,
      hostname: HOSTNAME,
      appPort: APP_PORT,
    });
    expect(status.state).toBe("failed");
    expect(status.lastError).toMatch(/unexpected public ports/);
    expect(calls.remove).toHaveLength(1); // best-effort rollback
    expect(handle).toBeNull();
  });

  it("fail-closed: keeps the handle but reports failed when the HTTPS probe does not validate", async () => {
    const { broker } = fakeBroker({
      expose: () => ({ handle: "handle-abcdef1234567890", publicPorts: [APP_PORT, HMR_PORT] }),
    });
    const { status, handle } = await provisionExposure(deps(broker, async () => false), {
      runtimeId: RUNTIME_ID,
      config: CONFIG,
      hostname: HOSTNAME,
      appPort: APP_PORT,
    });
    expect(status.state).toBe("failed");
    expect(status.publicUrl).toBeNull();
    expect(status.listeners).toHaveLength(2); // attempted mapping still surfaced
    expect(status.lastError).toMatch(/health probe/);
    // Handle retained so the caller can retry or clean up the dangling mapping.
    expect(handle).toBe("handle-abcdef1234567890");
  });

  it("fail-closed: treats a probe that throws as unhealthy", async () => {
    const { broker } = fakeBroker({
      expose: () => ({ handle: "handle-abcdef1234567890", publicPorts: [APP_PORT, HMR_PORT] }),
    });
    const { status } = await provisionExposure(
      deps(broker, async () => {
        throw new Error("cert error");
      }),
      { runtimeId: RUNTIME_ID, config: CONFIG, hostname: HOSTNAME, appPort: APP_PORT },
    );
    expect(status.state).toBe("failed");
  });
});

describe("deprovisionExposure", () => {
  it("is a no-op removal when no handle was ever recorded", async () => {
    const { broker, calls } = fakeBroker({});
    const { status, quarantinedPorts } = await deprovisionExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      handle: null,
      ports: [APP_PORT, HMR_PORT],
    });
    expect(calls.remove).toHaveLength(0);
    expect(status.state).toBe("removed");
    expect(quarantinedPorts).toEqual([]);
  });

  it("removes cleanly with a handle", async () => {
    const { broker, calls } = fakeBroker({ remove: () => ({ removedPorts: [APP_PORT, HMR_PORT] }) });
    const { status, quarantinedPorts } = await deprovisionExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      handle: "handle-abcdef1234567890",
      ports: [APP_PORT, HMR_PORT],
    });
    expect(calls.remove).toHaveLength(1);
    expect(status.state).toBe("removed");
    expect(quarantinedPorts).toEqual([]);
  });

  it("treats an already-gone mapping as removed (idempotent)", async () => {
    const { broker } = fakeBroker({
      remove: () => {
        throw new BrokerClientError("invalid_handle", "gone");
      },
    });
    const { status, quarantinedPorts } = await deprovisionExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      handle: "handle-abcdef1234567890",
      ports: [APP_PORT, HMR_PORT],
    });
    expect(status.state).toBe("removed");
    expect(quarantinedPorts).toEqual([]);
  });

  it("quarantines ports and reports cleanup_pending on an ambiguous cleanup failure", async () => {
    const { broker } = fakeBroker({
      remove: () => {
        throw new BrokerClientError("cli_error", "tailscale serve failed");
      },
    });
    const { status, quarantinedPorts } = await deprovisionExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      handle: "handle-abcdef1234567890",
      ports: [APP_PORT, HMR_PORT, APP_PORT],
    });
    expect(status.state).toBe("cleanup_pending");
    expect(status.lastError).toBe("cli_error");
    expect(quarantinedPorts).toEqual([APP_PORT, HMR_PORT]); // deduped
  });
});

describe("reconcileExposures", () => {
  it("adopts owned mappings that are still desired", async () => {
    const { broker, calls } = fakeBroker({
      list: () => [
        { runtimeId: RUNTIME_ID, port: APP_PORT, purpose: "app" },
        { runtimeId: RUNTIME_ID, port: HMR_PORT, purpose: "vite_hmr" },
      ],
    });
    const result = await reconcileExposures(deps(broker, async () => true), {
      desiredRuntimeIds: new Set([RUNTIME_ID]),
      handlesByRuntimeId: new Map(),
    });
    expect(result.adopted).toEqual([RUNTIME_ID]);
    expect(result.removedOrphanPorts).toEqual([]);
    expect(calls.remove).toHaveLength(0);
  });

  it("removes an orphaned owned mapping when a handle is available", async () => {
    const orphan = "99999999-2222-4333-8444-555566667777";
    const { broker, calls } = fakeBroker({
      list: () => [{ runtimeId: orphan, port: APP_PORT, purpose: "app" }],
      remove: () => ({ removedPorts: [APP_PORT] }),
    });
    const result = await reconcileExposures(deps(broker, async () => true), {
      desiredRuntimeIds: new Set([RUNTIME_ID]),
      handlesByRuntimeId: new Map([[orphan, "handle-abcdef1234567890"]]),
    });
    expect(result.removedOrphanPorts).toEqual([APP_PORT]);
    expect(calls.remove).toEqual([{ runtimeId: orphan, handle: "handle-abcdef1234567890" }]);
    expect(result.unremovableOrphans).toEqual([]);
  });

  it("never mutates an orphan it has no handle for (no remove call)", async () => {
    const orphan = "99999999-2222-4333-8444-555566667777";
    const { broker, calls } = fakeBroker({
      list: () => [{ runtimeId: orphan, port: APP_PORT, purpose: "app" }],
    });
    const result = await reconcileExposures(deps(broker, async () => true), {
      desiredRuntimeIds: new Set([RUNTIME_ID]),
      handlesByRuntimeId: new Map(),
    });
    expect(calls.remove).toHaveLength(0);
    expect(result.unremovableOrphans).toEqual([orphan]);
    expect(result.removedOrphanPorts).toEqual([]);
  });

  it("records non-fatal errors without aborting reconciliation", async () => {
    const orphanA = "aaaaaaaa-2222-4333-8444-555566667777";
    const orphanB = "bbbbbbbb-2222-4333-8444-555566667777";
    const { broker } = fakeBroker({
      list: () => [
        { runtimeId: orphanA, port: APP_PORT, purpose: "app" },
        { runtimeId: orphanB, port: APP_PORT + 1, purpose: "app" },
      ],
      remove: (runtimeId) => {
        if (runtimeId === orphanA) throw new BrokerClientError("cli_error", "boom");
        return { removedPorts: [APP_PORT + 1] };
      },
    });
    const result = await reconcileExposures(deps(broker, async () => true), {
      desiredRuntimeIds: new Set(),
      handlesByRuntimeId: new Map([
        [orphanA, "handle-aaaaaaaaaaaaaaaa"],
        [orphanB, "handle-bbbbbbbbbbbbbbbb"],
      ]),
    });
    expect(result.errors).toEqual([{ runtimeId: orphanA, code: "cli_error" }]);
    expect(result.removedOrphanPorts).toEqual([APP_PORT + 1]);
  });
});
