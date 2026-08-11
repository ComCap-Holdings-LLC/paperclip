/**
 * Paired app + Vite HMR port allocation for the `tailscale_https` exposure mode.
 *
 * A managed runtime that opts into HTTPS exposure needs TWO deterministically
 * related loopback ports reserved together (PAP-17049 plan, PAP-17050 verdict
 * requirement #2): the app port and its Paperclip Vite HMR companion at a fixed
 * offset. Allocating them as a pair — and only from the dedicated allowlisted
 * range — means a compromised caller can never ask the broker to publish an
 * arbitrary existing loopback service, and the HMR listener is never orphaned
 * from its app listener.
 *
 * Pure orchestration over an injected availability probe: no sockets here, so
 * the scan order and skip logic are unit-testable.
 */
import {
  RUNTIME_EXPOSURE_APP_PORT_MIN,
  RUNTIME_EXPOSURE_APP_PORT_MAX,
  deriveViteHmrPort,
  isRuntimeExposureAppPort,
} from "@paperclipai/shared";

export interface ExposurePortPair {
  appPort: number;
  hmrPort: number;
}

export interface AllocateExposurePortPairInput {
  /**
   * Returns true if the port can currently be bound loopback-only. Both the app
   * port and its HMR companion must pass before a pair is returned.
   */
  isPortAvailable: (port: number) => Promise<boolean>;
  /**
   * Ports that must never be handed out — e.g. quarantined after an ambiguous
   * cleanup, or already reserved by other live runtimes this cycle.
   */
  reserved?: ReadonlySet<number>;
}

/**
 * Scan the dedicated app-port range in ascending order and return the first
 * app port whose HMR companion is also free and unreserved. Throws when the
 * range is exhausted so the caller fails closed rather than binding an
 * out-of-range port.
 */
export async function allocateExposurePortPair(
  input: AllocateExposurePortPairInput,
): Promise<ExposurePortPair> {
  const reserved = input.reserved ?? new Set<number>();
  for (let appPort = RUNTIME_EXPOSURE_APP_PORT_MIN; appPort <= RUNTIME_EXPOSURE_APP_PORT_MAX; appPort += 1) {
    if (reserved.has(appPort)) continue;
    const hmrPort = deriveViteHmrPort(appPort);
    if (reserved.has(hmrPort)) continue;
    if (!isRuntimeExposureAppPort(appPort)) continue; // defensive; range guarantees it
    // Probe the app port first; short-circuit before probing the companion.
    if (!(await input.isPortAvailable(appPort))) continue;
    if (!(await input.isPortAvailable(hmrPort))) continue;
    return { appPort, hmrPort };
  }
  throw new Error(
    `no free app/HMR port pair available in the dedicated runtime exposure range ` +
      `[${RUNTIME_EXPOSURE_APP_PORT_MIN}, ${RUNTIME_EXPOSURE_APP_PORT_MAX}]`,
  );
}
