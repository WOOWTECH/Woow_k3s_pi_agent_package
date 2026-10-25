# Omnigent deployment package release

Goal: ship the verified Pi Omnigent plugin 0.3.11 in reproducible k3s/PaaS and Home Assistant addon packages, with fresh-install onboarding and native configuration access. No credentials or host identity are distributed. Only existing engines are connected.

1. Work from current authoritative branches in isolated worktrees; preserve concurrent work.
2. k3s: bundle the immutable plugin release, build the pinned native Pi Web adapter in CI, seed registration once, launch onboarding at first boot, preserve session-local PI_CODING_AGENT_DIR.
3. PaaS: retain API-key masking, error hints, provider refresh, interrupted-session recovery and model metadata when adapting the overlay to the native UI build. Publish a tested candidate based on the new base digest through the existing release workflow.
4. HA: preserve Pi Web 0.12.0 and ingress behavior; implement and test the addon integration independently, including amd64/aarch64 builds and local-build source inclusion. Release via required PR checks.
5. Verify fresh/returning/disabled/removed plugin registration, no model prompt on onboarding, secret-free package contents, and startup without a runtime UI build.
6. Publish Gitea source, verify GitHub mirror equality and image manifests. Update PaaS chart/documented image coordinates and regenerate the read-only PaaS mirror from its authoritative sources.
7. Verify HA stable Release, source notification, Store commit/payload and downloadable local-build version/source hashes. Separately report live Supervisor visibility if reachable.

Do not equate source publication with an image build or a live-store refresh. Record immutable refs, checks and any remaining approval gates in release evidence.
