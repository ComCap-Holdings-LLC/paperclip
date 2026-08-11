/**
 * Wire and domain types for the least-privilege Tailscale HTTPS host broker.
 *
 * The broker's only capability is adding and removing Paperclip-owned,
 * same-number HTTPS-to-loopback listeners. It never gains general Tailscale
 * administration. See PAP-17049 (plan) and PAP-17050 (threat-model verdict).
 *
 * SECURITY: every value that crosses the socket is untrusted. The Paperclip
 * caller, CLI output, Serve state, the registry, and listener metadata are all
 * treated as untrusted inputs.
 */

/** Supported broker protocol version. Requests on other versions are rejected. */
export const BROKER_PROTOCOL_VERSION = 1;

/** The protected primary route that must never change: `:443` -> loopback app. */
export const PROTECTED_PRIMARY_PORT = 443;
export const PROTECTED_PRIMARY_TARGET = "http://127.0.0.1:3100";

export type BrokerOp = "expose" | "remove" | "list";

/** Peer credentials obtained from the OS for an accepted socket connection. */
export interface PeerCredentials {
  uid: number;
  gid: number;
  pid: number;
}

/** A single owned HTTPS-to-loopback listener the broker manages. */
export interface OwnedListener {
  purpose: "app" | "vite_hmr";
  /** Public HTTPS port == target loopback port (same-number invariant). */
  port: number;
}

/** An expose request body (already schema-validated). */
export interface ExposeRequest {
  op: "expose";
  requestId: string;
  /** Runtime-service UUID the caller claims to own. */
  runtimeId: string;
  /** Loopback target ports to expose; each becomes a same-number HTTPS listener. */
  listeners: OwnedListener[];
}

/** A remove request body. Requires a prior expose lease handle. */
export interface RemoveRequest {
  op: "remove";
  requestId: string;
  runtimeId: string;
  /** Unguessable handle returned by `expose`; binds ownership. */
  handle: string;
}

/** A list request body. Scoped to the caller; never returns lease handles. */
export interface ListRequest {
  op: "list";
  requestId: string;
}

export type BrokerRequest = ExposeRequest | RemoveRequest | ListRequest;

export interface ExposeResponseOk {
  ok: true;
  op: "expose";
  requestId: string;
  /** Lease handle required for a later `remove`. Never logged. */
  handle: string;
  publicPorts: number[];
}

export interface RemoveResponseOk {
  ok: true;
  op: "remove";
  requestId: string;
  removedPorts: number[];
}

export interface ListResponseOk {
  ok: true;
  op: "list";
  requestId: string;
  /** Caller-owned listeners only; no handles, no manual/unknown Serve state. */
  listeners: Array<{ runtimeId: string; port: number; purpose: OwnedListener["purpose"] }>;
}

export interface BrokerErrorResponse {
  ok: false;
  requestId: string | null;
  /** Stable machine code; never leaks command lines, paths, or secrets. */
  code: BrokerErrorCode;
  message: string;
}

export type BrokerResponse =
  | ExposeResponseOk
  | RemoveResponseOk
  | ListResponseOk
  | BrokerErrorResponse;

export type BrokerErrorCode =
  | "unsupported_version"
  | "malformed_request"
  | "unknown_operation"
  | "unauthorized_peer"
  | "invalid_runtime_id"
  | "invalid_port"
  | "port_not_allowlisted"
  | "listener_not_owned"
  | "listener_ownership_mismatch"
  | "manual_mapping_present"
  | "primary_route_violation"
  | "invalid_handle"
  | "serve_parse_error"
  | "cli_error"
  | "cli_timeout"
  | "unexpected_serve_diff"
  | "quarantined"
  | "rate_limited"
  | "too_many_clients"
  | "internal_error";

/** A registry lease record persisted atomically under root ownership. */
export interface LeaseRecord {
  handle: string;
  runtimeId: string;
  /** Peer identity bound at expose time. */
  peerUid: number;
  peerGid: number;
  ports: number[];
  purposes: OwnedListener["purpose"][];
  /** Monotonic generation to defeat ABA remove/re-expose confusion. */
  generation: number;
  createdAtIso: string;
}

/** Registry persisted to a root-owned 0600 file via temp+fsync+rename. */
export interface BrokerRegistry {
  version: 1;
  /** Node/boot identity; a change forces quarantine + operator reconciliation. */
  nodeIdentity: string;
  generationCounter: number;
  leases: LeaseRecord[];
  /** Ports quarantined after ambiguous/failed cleanup; never reused/auto-freed. */
  quarantinedPorts: number[];
}
