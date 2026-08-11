import { describe, expect, it } from "vitest";
import {
  DEFAULT_TAILSCALE_HTTPS_EXPOSURE,
  parseRuntimeExposureConfig,
  runtimeExposureConfigSchema,
  runtimeExposureListenerSchema,
  runtimeExposureStatusSchema,
} from "./runtime-exposure.js";

describe("runtimeExposureConfigSchema", () => {
  it("accepts the default fail-closed config", () => {
    expect(() => runtimeExposureConfigSchema.parse(DEFAULT_TAILSCALE_HTTPS_EXPOSURE)).not.toThrow();
  });

  it("rejects unknown fields (no smuggled target/path/hostname suffix)", () => {
    expect(() =>
      runtimeExposureConfigSchema.parse({
        ...DEFAULT_TAILSCALE_HTTPS_EXPOSURE,
        target: "http://127.0.0.1:5432",
      }),
    ).toThrow();
  });

  it("rejects arbitrary hostname / publicPort / provider / failure policy", () => {
    expect(() =>
      runtimeExposureConfigSchema.parse({ ...DEFAULT_TAILSCALE_HTTPS_EXPOSURE, hostname: "evil.example" }),
    ).toThrow();
    expect(() =>
      runtimeExposureConfigSchema.parse({ ...DEFAULT_TAILSCALE_HTTPS_EXPOSURE, publicPort: 443 }),
    ).toThrow();
    expect(() =>
      runtimeExposureConfigSchema.parse({ ...DEFAULT_TAILSCALE_HTTPS_EXPOSURE, type: "funnel" }),
    ).toThrow();
    expect(() =>
      runtimeExposureConfigSchema.parse({ ...DEFAULT_TAILSCALE_HTTPS_EXPOSURE, failurePolicy: "fail_open" }),
    ).toThrow();
  });

  it("parseRuntimeExposureConfig returns null when absent and throws when malformed", () => {
    expect(parseRuntimeExposureConfig(undefined)).toBeNull();
    expect(parseRuntimeExposureConfig(null)).toBeNull();
    expect(parseRuntimeExposureConfig(DEFAULT_TAILSCALE_HTTPS_EXPOSURE)).toEqual(
      DEFAULT_TAILSCALE_HTTPS_EXPOSURE,
    );
    expect(() => parseRuntimeExposureConfig({ type: "tailscale_https" })).toThrow();
  });
});

describe("runtimeExposureListenerSchema", () => {
  it("enforces the same-number invariant", () => {
    expect(() =>
      runtimeExposureListenerSchema.parse({ purpose: "app", publicPort: 42010, targetPort: 42010 }),
    ).not.toThrow();
    expect(() =>
      runtimeExposureListenerSchema.parse({ purpose: "app", publicPort: 42010, targetPort: 5432 }),
    ).toThrow();
  });
});

describe("runtimeExposureStatusSchema", () => {
  it("accepts a well-formed ready status", () => {
    expect(() =>
      runtimeExposureStatusSchema.parse({
        provider: "tailscale_https",
        state: "ready",
        publicUrl: "https://paperclip-dev.tail29c1aa.ts.net:42010",
        hostname: "paperclip-dev.tail29c1aa.ts.net",
        listeners: [
          { purpose: "app", publicPort: 42010, targetPort: 42010 },
          { purpose: "vite_hmr", publicPort: 52010, targetPort: 52010 },
        ],
        brokerRef: "rs-1",
        lastError: null,
        updatedAt: "2026-08-11T00:00:00.000Z",
      }),
    ).not.toThrow();
  });

  it("rejects unknown fields in serialized status", () => {
    expect(() =>
      runtimeExposureStatusSchema.parse({
        provider: "tailscale_https",
        state: "ready",
        publicUrl: null,
        hostname: null,
        listeners: [],
        brokerRef: null,
        lastError: null,
        updatedAt: null,
        leaseHandle: "secret",
      }),
    ).toThrow();
  });
});
