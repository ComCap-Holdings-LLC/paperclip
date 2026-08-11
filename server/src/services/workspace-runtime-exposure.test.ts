import { afterEach, describe, expect, it } from "vitest";

import type { BrokerClient, BrokerListenerRequest } from "./runtime-exposure/broker-client.js";
import {
  resetRuntimeServicesForTests,
  setWorkspaceRuntimeExposureDepsForTests,
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForExecutionWorkspace,
} from "./workspace-runtime.js";

const EXECUTION_WORKSPACE_ID = "11111111-2222-4333-8444-555566667777";
const HANDLE = "handle-abcdef1234567890";

afterEach(async () => {
  await resetRuntimeServicesForTests();
});

function serviceCommand() {
  return `node -e 'const http=require("http");const p=Number(process.env.PORT);for(const q of [p,p+10000])http.createServer((_,r)=>{r.statusCode=200;r.end("ok")}).listen(q,"127.0.0.1");setInterval(()=>{},1000)'`;
}

function createBroker() {
  const calls: string[] = [];
  let listeners: BrokerListenerRequest[] = [];
  const broker: BrokerClient = {
    async reserve(_runtimeId, requested) {
      calls.push("reserve");
      listeners = requested;
      return { handle: HANDLE, reservedPorts: requested.map((listener) => listener.port) };
    },
    async expose() {
      calls.push("expose");
      return { handle: HANDLE, publicPorts: listeners.map((listener) => listener.port) };
    },
    async remove() {
      calls.push("remove");
      return { removedPorts: listeners.map((listener) => listener.port) };
    },
    async list() {
      return [];
    },
  };
  return { broker, calls };
}

function startInput() {
  return {
    invocationId: "runtime-exposure-test",
    actor: { id: null, name: "Paperclip", companyId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    issue: null,
    workspace: {
      baseCwd: process.cwd(),
      source: "project_primary" as const,
      projectId: null,
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      strategy: "project_primary" as const,
      cwd: process.cwd(),
      branchName: "test",
      worktreePath: null,
      warnings: [],
      created: false,
    },
    executionWorkspaceId: EXECUTION_WORKSPACE_ID,
    config: {
      workspaceRuntime: {
        services: [{
          name: "preview",
          command: serviceCommand(),
          port: { type: "auto", envKey: "PORT" },
          readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 5 },
          expose: {
            type: "tailscale_https",
            hostname: "auto",
            publicPort: "same",
            includePaperclipViteHmr: true,
            failurePolicy: "fail_closed",
          },
        }],
      },
    },
    adapterEnv: {},
  };
}

describe("workspace runtime tailscale_https lifecycle", () => {
  it("reserves before spawn, exposes after backend readiness, and removes on stop", async () => {
    const { broker, calls } = createBroker();
    setWorkspaceRuntimeExposureDepsForTests({
      broker,
      isPortAvailable: async () => true,
      resolveHostname: async () => "runner.tail123.ts.net",
      probeHealth: async () => true,
      now: () => "2026-08-11T00:00:00.000Z",
    });

    const [runtime] = await startRuntimeServicesForWorkspaceControl(startInput());
    expect(calls.slice(0, 2)).toEqual(["reserve", "expose"]);
    expect(runtime.port).toBeGreaterThanOrEqual(42000);
    expect(runtime.url).toBe(`https://runner.tail123.ts.net:${runtime.port}`);
    expect(runtime.exposure?.state).toBe("ready");

    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: EXECUTION_WORKSPACE_ID,
      runtimeServiceId: runtime.id,
    });
    expect(calls).toEqual(["reserve", "expose", "remove"]);
  }, 15_000);

  it("fails closed and removes the mapping when external HTTPS validation fails", async () => {
    const { broker, calls } = createBroker();
    setWorkspaceRuntimeExposureDepsForTests({
      broker,
      isPortAvailable: async () => true,
      resolveHostname: async () => "runner.tail123.ts.net",
      probeHealth: async () => false,
      now: () => "2026-08-11T00:00:00.000Z",
    });

    await expect(startRuntimeServicesForWorkspaceControl(startInput())).rejects.toThrow(/HTTPS exposure failed/);
    expect(calls).toEqual(["reserve", "expose", "remove"]);
  }, 15_000);
});
