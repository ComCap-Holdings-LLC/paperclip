# ComCap CI runners

All workflow jobs in this fork use `hermes-ephemeral`. The GitHub Actions
control plane schedules work; Hermes servers execute it. Do not add hosted
runner labels or a hosted fallback. Keep the organization Actions allowlist
restricted to approved repositories.

The PR workflow preserves the existing check names, shard coverage, typecheck,
tests, and build. Its default checkout tests GitHub's PR merge result. Test
failures remain failures, including failures also seen on master. Repair
sandbox and load problems in Hermes before changing application tests.

The Docker workflow publishes commit images to GHCR. Deploy production consumes
a successful master Docker run and deploys that immutable commit through the
existing SSH forced command, backup, health check, and rollback path. Runner
migration does not authorize a merge or bypass independent review.

Before enabling this repository at the organization level, land this workflow
migration through independent review, configure Hermes runner provisioning for
this repository, and verify Docker/Buildx support inside the isolated worker.
The prior hosted-runner disk cleanup has been removed: it must never prune a
shared server's Docker storage or remove host toolchains.
