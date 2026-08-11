import { z } from "zod";

/**
 * Validators for the opt-in `tailscale_https` runtime exposure contract.
 * Strict-by-default: unknown fields are rejected so a malformed or injected
 * config cannot smuggle an arbitrary target, path, or hostname suffix through
 * the runtime configuration into the broker (PAP-17050 verdict).
 */

export const runtimeExposureProviderSchema = z.literal("tailscale_https");

export const runtimeExposureFailurePolicySchema = z.literal("fail_closed");

export const runtimeExposureConfigSchema = z
  .object({
    type: runtimeExposureProviderSchema,
    hostname: z.literal("auto"),
    publicPort: z.literal("same"),
    includePaperclipViteHmr: z.boolean(),
    failurePolicy: runtimeExposureFailurePolicySchema,
  })
  .strict();

export const runtimeExposureStateSchema = z.enum([
  "pending",
  "ready",
  "failed",
  "cleanup_pending",
  "removed",
]);

export const runtimeExposureListenerPurposeSchema = z.enum(["app", "vite_hmr"]);

export const runtimeExposureListenerSchema = z
  .object({
    purpose: runtimeExposureListenerPurposeSchema,
    publicPort: z.number().int().positive(),
    targetPort: z.number().int().positive(),
  })
  .strict()
  // Same-number invariant: the public HTTPS port must equal the loopback
  // target port. The broker enforces this too, but rejecting here keeps
  // persisted/serialized state honest.
  .refine((listener) => listener.publicPort === listener.targetPort, {
    message: "publicPort must equal targetPort (same-number exposure)",
    path: ["publicPort"],
  });

export const runtimeExposureStatusSchema = z
  .object({
    provider: runtimeExposureProviderSchema,
    state: runtimeExposureStateSchema,
    publicUrl: z.string().url().nullable(),
    hostname: z.string().min(1).nullable(),
    listeners: z.array(runtimeExposureListenerSchema),
    brokerRef: z.string().min(1).nullable(),
    lastError: z.string().nullable(),
    updatedAt: z.string().nullable(),
  })
  .strict();

export type RuntimeExposureConfigInput = z.infer<typeof runtimeExposureConfigSchema>;
export type RuntimeExposureStatusInput = z.infer<typeof runtimeExposureStatusSchema>;

/**
 * Default exposure config used when a project/workspace enables HTTPS exposure
 * without overriding sub-fields. Fail-closed and HMR-inclusive by default so
 * dev-mode hot reload works over the exposed HTTPS origin.
 */
export const DEFAULT_TAILSCALE_HTTPS_EXPOSURE: RuntimeExposureConfigInput = {
  type: "tailscale_https",
  hostname: "auto",
  publicPort: "same",
  includePaperclipViteHmr: true,
  failurePolicy: "fail_closed",
};

/**
 * Parse an untrusted `expose` block off a workspace runtime service config.
 * Returns null when exposure is absent; throws (via zod) on a malformed block
 * so misconfiguration fails closed rather than silently exposing nothing.
 */
export function parseRuntimeExposureConfig(
  value: unknown,
): RuntimeExposureConfigInput | null {
  if (value === undefined || value === null) return null;
  return runtimeExposureConfigSchema.parse(value);
}
