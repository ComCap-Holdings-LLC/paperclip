# Paperclip Tailscale HTTPS broker

Least-privilege host broker that manages **only** Paperclip-owned, tailnet-only,
same-number HTTPS-to-loopback listeners for managed branch runtimes.

It exists so the Paperclip app/agent account never gains Tailscale operator
authority (see [PAP-16989](../../)) while still getting automatic trusted HTTPS
previews per branch runtime. Design: [PAP-17049](../../) plan; security contract:
[PAP-17050](../../) threat-model verdict.

## What it can and cannot do

Supported operations (over a Unix socket, one runtime-service at a time):

- `list` — the caller's own exposures (never returns lease handles).
- `expose` — add same-number HTTPS→loopback listeners for an allowlisted port,
  returning an unguessable lease handle.
- `remove` — remove the caller's own listeners, proven by exact lease handle.

Hard-denied, deny-by-default: Funnel, certificates, Tailscale Services,
`serve reset` / `set-config`, path handlers, arbitrary targets, non-loopback or
wildcard/dual-stack backends, port `443`, privileged/reserved ports, ports
outside the dedicated runtime range, unknown fields, and removal of any mapping
not matching an exact registry + lease + live Serve entry. The primary
`:443 → 127.0.0.1:3100` route is verified structurally **before and after every
mutation** and is never modified.

## One-time host installation (`paperclip-dev`)

These steps require **root** and must be run by CloudOps/host owner, not the
Paperclip agent account. They install the broker as a dedicated
Tailscale-operator service account distinct from the Paperclip app account.

1. **Preconditions.** Tailscale is installed and up on the node, the node has an
   HTTPS-capable trusted cert (MagicDNS + HTTPS enabled), and the existing
   `:443 → 127.0.0.1:3100` Serve mapping is present.

2. **Create the dedicated operator account and socket group.**

   ```sh
   sudo useradd --system --home /var/lib/paperclip-tailscale-broker \
     --shell /usr/sbin/nologin paperclip-tsbroker
   sudo groupadd --system paperclip-tsbroker-sock
   # The Paperclip *app* service account must have this as its PRIMARY group so
   # its SO_PEERCRED gid matches the socket group (supplemental membership is
   # intentionally NOT accepted).
   sudo usermod -g paperclip-tsbroker-sock <paperclip-app-account>
   ```

3. **Grant Tailscale operator authority to the broker account only.**

   ```sh
   sudo tailscale set --operator=paperclip-tsbroker
   ```

   Do **not** grant `--operator` to the Paperclip app/agent account (that grant
   was explicitly rejected in PAP-16989).

4. **Create state directories (root-owned, not writable by others).**

   ```sh
   sudo install -d -o root -g root -m 0755 /run/paperclip-tailscale-broker
   sudo install -d -o paperclip-tsbroker -g root -m 0700 /var/lib/paperclip-tailscale-broker
   sudo install -d -o paperclip-tsbroker -g root -m 0700 /var/log/paperclip-tailscale-broker
   ```

   The broker refuses to start if the registry path's parent is group/other
   writable.

5. **Install a systemd unit** (`/etc/systemd/system/paperclip-tailscale-broker.service`):

   ```ini
   [Unit]
   Description=Paperclip Tailscale HTTPS broker
   After=tailscaled.service
   Requires=tailscaled.service

   [Service]
   Type=simple
   User=paperclip-tsbroker
   # Socket must end up 0660 root:paperclip-tsbroker-sock. Set the group here and
   # the broker chmods the socket to 0660 on bind.
   SupplementaryGroups=paperclip-tsbroker-sock
   Environment=BROKER_NODE_IDENTITY=%H
   Environment=BROKER_SERVICE_UID=<uid of paperclip app account>
   Environment=BROKER_SERVICE_GID=<gid of paperclip-tsbroker-sock>
   Environment=BROKER_RUNTIME_UID=<uid of the dedicated managed-runtime account>
   Environment=BROKER_TAILSCALE_BIN=/usr/bin/tailscale
   # Only when SO_PEERCRED is not wired and the socket is confirmed 0660
   # root:<group>. Prefer a native SO_PEERCRED reader when available.
   Environment=BROKER_TRUST_SOCKET_PERMISSIONS=true
   ExecStart=/usr/bin/node /opt/paperclip/packages/tailscale-https-broker/dist/main.js
   Restart=on-failure
   NoNewPrivileges=true
   ProtectSystem=strict
   ReadWritePaths=/run/paperclip-tailscale-broker /var/lib/paperclip-tailscale-broker /var/log/paperclip-tailscale-broker

   [Install]
   WantedBy=multi-user.target
   ```

   Environment variables (defaults in `src/config.ts`):

   | Var | Required | Default | Meaning |
   |-----|----------|---------|---------|
   | `BROKER_NODE_IDENTITY` | yes | — | hostname + boot id; a change forces quarantine + operator reconciliation |
   | `BROKER_SERVICE_UID` | yes | — | UID of the Paperclip **app** account allowed to connect |
   | `BROKER_SERVICE_GID` | yes | — | GID of the dedicated socket group (caller's primary GID) |
   | `BROKER_RUNTIME_UID` | yes | — | UID of the dedicated managed-runtime account whose loopback listeners are eligible |
   | `BROKER_TAILSCALE_BIN` | no | `/usr/bin/tailscale` | absolute path to the Tailscale CLI |
   | `BROKER_SOCKET_PATH` | no | `/run/paperclip-tailscale-broker/broker.sock` | Unix socket path |
   | `BROKER_REGISTRY_PATH` | no | `/var/lib/paperclip-tailscale-broker/registry.json` | root-owned `0600` ownership registry |
   | `BROKER_AUDIT_PATH` | no | `/var/log/paperclip-tailscale-broker/audit.log` | append-only security audit log |
   | `BROKER_TRUST_SOCKET_PERMISSIONS` | no | unset | assert socket is `0660 root:<group>` when no native `SO_PEERCRED` reader is wired |

6. **Preflight (read-only, no mutation).**

   ```sh
   sudo -u paperclip-tsbroker \
     BROKER_NODE_IDENTITY=$(hostname) BROKER_SERVICE_UID=... BROKER_SERVICE_GID=... BROKER_RUNTIME_UID=... \
     node /opt/paperclip/packages/tailscale-https-broker/dist/main.js --doctor
   ```

   Verifies: supported Tailscale CLI version, Serve status is readable, the
   primary `:443` route is intact, the registry path is safe, and prints the
   node identity. Exit 0 = ready. It never mutates Serve state.

7. **Enable.** `sudo systemctl daemon-reload && sudo systemctl enable --now
   paperclip-tailscale-broker`. Confirm the socket is `0660 root:<group>`.

## Upgrade

Deploy new package output, `systemctl restart paperclip-tailscale-broker`. On
restart the broker re-reads its root-owned registry and adopts only exact-lease
matches; a changed `BROKER_NODE_IDENTITY` (host reimage / boot-id change) forces
quarantine and operator reconciliation rather than silently re-adopting.

## Uninstall / rollback / opt-out

Rollback disables new exposure and removes only broker-owned listeners; it never
resets Serve or changes the primary route.

1. Disable the exposure flag on the project runtime (Paperclip stops requesting
   `expose`). Existing previews drain on runtime stop.
2. Drain owned listeners: stop each managed runtime so Paperclip issues `remove`
   for its own leases (proven by handle).
3. `sudo systemctl disable --now paperclip-tailscale-broker`.
4. Optional cleanup: remove the state dirs and `sudo tailscale set --operator=`
   to drop the operator grant. Do **not** run `tailscale serve reset` — remove
   only the specific per-port Serve entries if any remain.

## Recovery

If a mutation fails partway, the broker removes only the exact listeners it
applied; if exact cleanup cannot be proven it quarantines the affected ports and
reports `cleanup_pending` (partial app+HMR exposure is never reported healthy).
Quarantined ports are not reused until an operator clears them. The append-only
audit log at `BROKER_AUDIT_PATH` records every allow/deny and mutation outcome
(peer UID/GID/PID, operation, runtime UUID, ports, decision reason, before/after
state digests, quarantine/recovery) with lease handles and raw CLI output
redacted.

## Tests

```sh
pnpm --filter @paperclipai/tailscale-https-broker test        # 57 tests
pnpm --filter @paperclipai/tailscale-https-broker typecheck
```
