/**
 * Real Tailscale CLI runner: direct spawn with shell:false, absolute binary,
 * minimal environment, closed inherited fds, bounded output, and a hard
 * timeout+kill (PAP-17050 verdict requirement #4). Used by `main.ts` to build
 * the BrokerCore `runTailscale` dependency.
 */
import { spawnSync } from "node:child_process";
import type { CliResult } from "./broker-core.js";

const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Tailscale CLI versions this broker has been validated against (pinned). */
export const SUPPORTED_TAILSCALE_VERSIONS = new Set<string>(["1.80", "1.82", "1.84"]);

export function createTailscaleRunner(options: { timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (argv: string[]): CliResult => {
    const [bin, ...args] = argv;
    const result = spawnSync(bin, args, {
      shell: false,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: "/nonexistent",
      },
      cwd: "/",
    });
    const timedOut = result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return {
      code: typeof result.status === "number" ? result.status : timedOut ? 124 : 1,
      stdout: (result.stdout ?? "").toString("utf8").slice(0, MAX_OUTPUT_BYTES),
      stderr: (result.stderr ?? "").toString("utf8").slice(0, MAX_OUTPUT_BYTES),
      timedOut,
    };
  };
}

/** Parse the `major.minor` prefix of `tailscale version` output. */
export function parseTailscaleMinor(versionOutput: string): string | null {
  const match = /^\s*(\d+)\.(\d+)/.exec(versionOutput);
  return match ? `${match[1]}.${match[2]}` : null;
}

export function isSupportedTailscaleVersion(versionOutput: string): boolean {
  const minor = parseTailscaleMinor(versionOutput);
  return minor !== null && SUPPORTED_TAILSCALE_VERSIONS.has(minor);
}
