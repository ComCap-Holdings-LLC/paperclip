import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  classifyAdapterFailureForRecovery,
  classifyContinuationFailure,
} from "./service.js";

describe("classifyAdapterFailureForRecovery", () => {
  it("classifies usage-limit messages and parses the provider reset time", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the default recovery backoff when quota reset time is absent", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Provider quota exceeded for this model.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("treats timezone-less provider reset clocks as UTC", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 4:30 PM.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-16T16:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("parses provider reset clocks in 24-hour format", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 21:30 (UTC).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it.each([
    "model_not_found: requested model does not exist",
    "No API credentials were found for this provider",
    "API key is not set",
  ])("classifies configuration failures: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("ignores quota-like text from non-adapter failures", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "timeout",
      error: "Provider quota exceeded while waiting for a downstream service.",
      resultJson: null,
    })).toBeNull();
  });

  it("does not treat a generic capacity limit as provider quota", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });

  // COM-11514: a gateway auth failure used to fall through every branch here
  // and return null, so reconcileStrandedAssignedIssues treated it as a generic
  // stall and requeued the issue to `todo`. That re-woke an assignee who could
  // not possibly fix a credential, which is the churn loop this ticket filed.
  it.each([
    "hermes_gateway_auth_failed",
    "hermes_gateway_api_key_missing",
    "hermes_gateway_api_base_url_missing",
    "hermes_gateway_api_base_url_invalid",
    "hermes_gateway_plain_http_remote_denied",
    "cursor_cloud_auth_failed",
  ])("classifies credential/endpoint failure %s as configuration_incomplete", (errorCode) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode,
      error: "Check adapterConfig.apiKey matches the Hermes API_SERVER_KEY for the running gateway.",
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("classifies credential failures without needing quota or config text in the message", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "hermes_gateway_auth_failed",
      error: "",
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  // The other side of the split: gateway transport faults are genuinely
  // transient, so they must NOT be pushed to blocked as configuration problems.
  it.each([
    "hermes_gateway_rate_limited",
    "hermes_gateway_upstream_error",
    "hermes_gateway_connect_failed",
    "hermes_gateway_timeout",
  ])("leaves transient gateway transport failure %s unclassified", (errorCode) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode,
      error: "Gateway is temporarily unavailable.",
      resultJson: null,
    })).toBeNull();
  });
});

describe("classifyContinuationFailure gateway codes", () => {
  const run = (errorCode: string | null) =>
    ({ errorCode } as unknown as Parameters<typeof classifyContinuationFailure>[0]);

  it.each([
    "hermes_gateway_connect_failed",
    "hermes_gateway_rate_limited",
    "hermes_gateway_upstream_error",
    "hermes_gateway_timeout",
  ])("retries transient gateway transport failure %s", (errorCode) => {
    expect(classifyContinuationFailure(run(errorCode)).kind).toBe("transient_infra");
  });

  it("does not put a gateway auth failure on the transient retry path", () => {
    expect(classifyContinuationFailure(run("hermes_gateway_auth_failed")).kind).not.toBe("transient_infra");
  });
});
