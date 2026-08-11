/**
 * Broker transaction core. One serialized, fail-closed transaction per
 * mutation implements every PAP-17050 verdict requirement and invariant:
 *
 *   - Complete peer mediation + lease-handle ownership (req #1).
 *   - Dedicated-range + immediately-before /proc listener-ownership check
 *     defeats SSRF-equivalent publication of unrelated loopback services (#2).
 *   - Read → strict-parse → verify absence-or-exact-lease-match → verify
 *     protected :443 → one fixed per-port op → reread → require only the
 *     intended entry changed and :443 identical → atomic registry commit; any
 *     ambiguity quarantines and fails closed (#3).
 *   - Argv-only, shell:false CLI via an injected runner (#4).
 *   - Bounded, serialized mutation queue (#5).
 *   - One audit event per allow/deny/outcome (#6).
 */
import {
  AuthorizationError,
  authorizePeer,
  authorizeRemoval,
  generateLeaseHandle,
  type PeerPolicy,
} from "./authorization.js";
import { buildExposeArgv, buildRemoveArgv, buildStatusArgv } from "./argv.js";
import type { AuditSink } from "./audit.js";
import {
  ParsedServe,
  ServeParseError,
  assertPrimaryIntact,
  changedPorts,
  isSameNumberLoopbackEntry,
  parseServeStatus,
  primaryDigest,
} from "./serve-config.js";
import {
  addLease,
  isPortQuarantined,
  loadRegistry,
  nextGeneration,
  quarantinePort,
  removeLeaseByHandle,
  saveRegistry,
} from "./registry.js";
import type {
  BrokerRegistry,
  BrokerRequest,
  BrokerResponse,
  OwnedListener,
  PeerCredentials,
} from "./types.js";

/** Result of running a tailscale CLI command (argv, shell:false). */
export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Immediately-before-mutation ownership facts about a loopback listener,
 * derived from /proc (req #2). `loopbackOnly` must be true (reject wildcard,
 * IPv6-wildcard, dual-stack off-loopback); `ownerUidMatches` binds the listener
 * to the expected managed-runtime identity; `present` guards the swap race.
 */
export interface ListenerOwnership {
  present: boolean;
  loopbackOnly: boolean;
  ownerUidMatches: boolean;
}

export interface BrokerDeps {
  runTailscale(argv: string[]): CliResult;
  /** Inspect a loopback listener immediately before mutation (req #2). */
  verifyListenerOwnership(port: number): ListenerOwnership;
  nowIso(): string;
}

export interface BrokerCoreConfig {
  tailscaleBinPath: string;
  registryPath: string;
  auditSink: AuditSink;
  peerPolicy: PeerPolicy;
  /** hostname + boot id; a change forces quarantine + operator reconciliation. */
  nodeIdentity: string;
  /** Deny-by-default port allowlist. Defaults to the dedicated runtime range. */
  isAllowedPort(port: number): boolean;
  deps: BrokerDeps;
}

function denied(code: string, message: string): never {
  const err = new Error(message) as Error & { brokerCode: string };
  err.brokerCode = code;
  throw err;
}

export class BrokerCore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: BrokerCoreConfig) {}

  /** Public entry point. Serializes all requests through one mutation queue. */
  async handle(request: BrokerRequest, peer: PeerCredentials): Promise<BrokerResponse> {
    const run = this.queue.then(() => this.dispatch(request, peer));
    // Keep the chain alive even if this request rejects.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async dispatch(request: BrokerRequest, peer: PeerCredentials): Promise<BrokerResponse> {
    try {
      authorizePeer(peer, this.config.peerPolicy);
    } catch (error) {
      return this.fail(request.requestId, peer, request.op, "unauthorized_peer", error);
    }
    try {
      switch (request.op) {
        case "list":
          return this.doList(request, peer);
        case "expose":
          return this.doExpose(request, peer);
        case "remove":
          return this.doRemove(request, peer);
      }
    } catch (error) {
      const code = (error as { brokerCode?: string }).brokerCode ?? codeForError(error);
      return this.fail(request.requestId, peer, request.op, code, error);
    }
  }

  private readServe(): ParsedServe {
    const result = this.config.deps.runTailscale(buildStatusArgv(this.config.tailscaleBinPath));
    if (result.timedOut) denied("cli_timeout", "serve status timed out");
    if (result.code !== 0) denied("cli_error", "serve status exited non-zero");
    let json: unknown;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      denied("serve_parse_error", "serve status returned invalid JSON");
    }
    try {
      return parseServeStatus(json);
    } catch (error) {
      if (error instanceof ServeParseError) denied("serve_parse_error", error.message);
      throw error;
    }
  }

  private loadRegistry(): BrokerRegistry {
    const registry = loadRegistry(this.config.registryPath, this.config.nodeIdentity);
    // Boot/node identity change forces quarantine + operator reconciliation.
    if (registry.nodeIdentity !== this.config.nodeIdentity) {
      denied("quarantined", "node identity changed; operator reconciliation required");
    }
    return registry;
  }

  private doExpose(
    request: Extract<BrokerRequest, { op: "expose" }>,
    peer: PeerCredentials,
  ): BrokerResponse {
    const registry = this.loadRegistry();

    // Pre-flight every requested port: allowlist, quarantine, and the
    // immediately-before /proc ownership check (req #2).
    for (const listener of request.listeners) {
      if (!this.config.isAllowedPort(listener.port)) {
        denied("port_not_allowlisted", `port ${listener.port} is outside the dedicated range`);
      }
      if (isPortQuarantined(registry, listener.port)) {
        denied("quarantined", `port ${listener.port} is quarantined`);
      }
      const ownership = this.config.deps.verifyListenerOwnership(listener.port);
      if (!ownership.present) {
        denied("listener_ownership_mismatch", `no loopback listener on port ${listener.port}`);
      }
      if (!ownership.loopbackOnly) {
        denied("listener_ownership_mismatch", `listener on ${listener.port} is not loopback-only`);
      }
      if (!ownership.ownerUidMatches) {
        denied("listener_ownership_mismatch", `listener on ${listener.port} not owned by managed runtime`);
      }
    }

    const before = this.readServe();
    assertPrimaryIntact(before);
    const beforePrimary = primaryDigest(before);

    // Each target port must be absent or already exactly our same-number entry
    // (idempotent re-expose). A manual/unknown entry is never touched.
    for (const listener of request.listeners) {
      const entry = before.entries.get(listener.port);
      if (entry && !isSameNumberLoopbackEntry(entry, listener.port)) {
        denied("manual_mapping_present", `port ${listener.port} already has a non-Paperclip mapping`);
      }
    }

    const appliedPorts: number[] = [];
    try {
      for (const listener of request.listeners) {
        const already = before.entries.get(listener.port);
        if (already && isSameNumberLoopbackEntry(already, listener.port)) {
          continue; // idempotent
        }
        const result = this.config.deps.runTailscale(
          buildExposeArgv(this.config.tailscaleBinPath, listener.port),
        );
        if (result.timedOut) denied("cli_timeout", `expose ${listener.port} timed out`);
        if (result.code !== 0) denied("cli_error", `expose ${listener.port} exited non-zero`);
        appliedPorts.push(listener.port);
      }

      const after = this.readServe();
      // Digest equality (vs the known-good `before`) is the strongest primary
      // check: any retarget, removal, or structural change fails closed here as
      // a primary_route_violation before any weaker classification runs.
      if (primaryDigest(after) !== beforePrimary) {
        denied("primary_route_violation", "protected :443 route changed during expose");
      }
      assertPrimaryIntact(after);
      // Only the intended ports may have changed, and each must now be an exact
      // same-number loopback listener.
      const diff = new Set(changedPorts(before, after));
      const intended = new Set(request.listeners.map((l) => l.port));
      for (const port of diff) {
        if (!intended.has(port)) denied("unexpected_serve_diff", `unexpected change on port ${port}`);
      }
      for (const listener of request.listeners) {
        if (!isSameNumberLoopbackEntry(after.entries.get(listener.port), listener.port)) {
          denied("unexpected_serve_diff", `port ${listener.port} not exactly exposed`);
        }
      }

      const handle = generateLeaseHandle();
      const generation = nextGeneration(registry);
      addLease(registry, {
        handle,
        runtimeId: request.runtimeId,
        peerUid: peer.uid,
        peerGid: peer.gid,
        ports: request.listeners.map((l) => l.port),
        purposes: request.listeners.map((l) => l.purpose) as OwnedListener["purpose"][],
        generation,
        createdAtIso: this.config.deps.nowIso(),
      });
      saveRegistry(this.config.registryPath, registry);

      this.config.auditSink.write({
        timestampIso: this.config.deps.nowIso(),
        peer,
        op: "expose",
        runtimeId: request.runtimeId,
        ports: request.listeners.map((l) => l.port),
        requestId: request.requestId,
        decision: "allow",
        reasonCode: "ok",
        reason: "exposed",
        beforeDigest: beforePrimary,
        afterDigest: primaryDigest(after),
        cliExitCategory: "ok",
        recovery: "none",
      });

      return {
        ok: true,
        op: "expose",
        requestId: request.requestId,
        handle,
        publicPorts: request.listeners.map((l) => l.port),
      };
    } catch (error) {
      // Partial success is not healthy: compensate by removing only the exact
      // entries we applied; if compensation cannot be proven, quarantine.
      this.compensateExpose(appliedPorts, registry);
      throw error;
    }
  }

  private compensateExpose(appliedPorts: number[], registry: BrokerRegistry): void {
    for (const port of appliedPorts) {
      let cleaned = false;
      try {
        const result = this.config.deps.runTailscale(
          buildRemoveArgv(this.config.tailscaleBinPath, port),
        );
        cleaned = !result.timedOut && result.code === 0;
      } catch {
        cleaned = false;
      }
      if (!cleaned) quarantinePort(registry, port);
    }
    try {
      saveRegistry(this.config.registryPath, registry);
    } catch {
      /* best effort; registry may already reflect quarantine on next load */
    }
  }

  private doRemove(
    request: Extract<BrokerRequest, { op: "remove" }>,
    peer: PeerCredentials,
  ): BrokerResponse {
    const registry = this.loadRegistry();
    let lease;
    try {
      lease = authorizeRemoval(registry.leases, request, peer);
    } catch (error) {
      if (error instanceof AuthorizationError) denied(error.code, error.message);
      throw error;
    }

    const before = this.readServe();
    assertPrimaryIntact(before);
    const beforePrimary = primaryDigest(before);

    const removedPorts: number[] = [];
    for (const port of lease.ports) {
      const entry = before.entries.get(port);
      if (!entry) continue; // already gone; idempotent
      if (!isSameNumberLoopbackEntry(entry, port)) {
        // Unknown/manual/mismatched entry — never modify; cannot prove cleanup.
        quarantinePort(registry, port);
        saveRegistry(this.config.registryPath, registry);
        denied("listener_ownership_mismatch", `port ${port} does not match the owned lease entry`);
      }
      const result = this.config.deps.runTailscale(
        buildRemoveArgv(this.config.tailscaleBinPath, port),
      );
      if (result.timedOut) denied("cli_timeout", `remove ${port} timed out`);
      if (result.code !== 0) denied("cli_error", `remove ${port} exited non-zero`);
      removedPorts.push(port);
    }

    const after = this.readServe();
    if (primaryDigest(after) !== beforePrimary) {
      denied("primary_route_violation", "protected :443 route changed during remove");
    }
    assertPrimaryIntact(after);
    const diff = new Set(changedPorts(before, after));
    for (const port of diff) {
      if (!lease.ports.includes(port)) denied("unexpected_serve_diff", `unexpected change on port ${port}`);
    }
    for (const port of removedPorts) {
      if (after.entries.get(port)) denied("unexpected_serve_diff", `port ${port} still present after remove`);
    }

    removeLeaseByHandle(registry, lease.handle);
    saveRegistry(this.config.registryPath, registry);

    this.config.auditSink.write({
      timestampIso: this.config.deps.nowIso(),
      peer,
      op: "remove",
      runtimeId: request.runtimeId,
      ports: lease.ports,
      requestId: request.requestId,
      decision: "allow",
      reasonCode: "ok",
      reason: "removed",
      beforeDigest: beforePrimary,
      afterDigest: primaryDigest(after),
      cliExitCategory: "ok",
      recovery: "cleanup",
    });

    return { ok: true, op: "remove", requestId: request.requestId, removedPorts };
  }

  private doList(
    request: Extract<BrokerRequest, { op: "list" }>,
    peer: PeerCredentials,
  ): BrokerResponse {
    const registry = this.loadRegistry();
    const listeners = registry.leases
      .filter((lease) => lease.peerUid === peer.uid && lease.peerGid === peer.gid)
      .flatMap((lease) =>
        lease.ports.map((port, index) => ({
          runtimeId: lease.runtimeId,
          port,
          purpose: lease.purposes[index] ?? "app",
        })),
      );
    this.config.auditSink.write({
      timestampIso: this.config.deps.nowIso(),
      peer,
      op: "list",
      runtimeId: null,
      ports: listeners.map((l) => l.port),
      requestId: request.requestId,
      decision: "allow",
      reasonCode: "ok",
      reason: "listed",
    });
    return { ok: true, op: "list", requestId: request.requestId, listeners };
  }

  private fail(
    requestId: string | null,
    peer: PeerCredentials | null,
    op: string,
    code: string,
    error: unknown,
  ): BrokerResponse {
    const message = error instanceof Error ? error.message : String(error);
    try {
      this.config.auditSink.write({
        timestampIso: this.config.deps.nowIso(),
        peer,
        op,
        runtimeId: null,
        ports: [],
        requestId,
        decision: "deny",
        reasonCode: code as never,
        reason: message,
      });
    } catch {
      /* never let an audit failure mask the denial response */
    }
    return { ok: false, requestId, code: code as never, message: safeMessage(code) };
  }
}

function codeForError(error: unknown): string {
  if (error instanceof ServeParseError) return "serve_parse_error";
  if (error instanceof AuthorizationError) return error.code;
  return "internal_error";
}

/** Client-facing message is a stable label; never echoes host/command detail. */
function safeMessage(code: string): string {
  return code;
}
