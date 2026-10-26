# Root image publication

`build.yml` publishes **only** a candidate named
`sha-<full-source-sha>-<run-id>-<run-attempt>`. Rebuilds and reruns get different
names; downstream verification uses the recorded `sha256` digest. Neither a main
merge, tag push, successful build, nor cancelled build changes `main`, `latest`,
or a version alias. Old images and tags are retained for investigation.

The same workflow then runs bounded acceptance on that exact digest: offline
startup contracts on every built architecture, and a fresh isolated data volume
with real desktop/mobile browsers on amd64. The untouched homepage must select
the saved setup conversation and display its initial prompt and empty URL field.
A container restart must preserve the same onboarding identity. The containers
have no provider credentials or external network access and are cleaned up by
owned resource IDs/labels. This is image smoke acceptance; it does not certify
real-provider replies, a connected-host full VM reboot, fleet rollout, or HA Store
distribution. Those release-specific checks still belong in the release record.

The browser runner connects directly to the private address of the owned internal
bridge; no external route or public host port is enabled. The disposable browser
fixture explicitly sets `PI_WEB_HOSTNAME=0.0.0.0` so its HTTP listener is reachable
on that bridge; the application default stays loopback. Before using that
address, QA requires a running container, matching owner labels on both resources,
exactly one attached network with the expected ID, and an IPv4 address inside both
that network's CIDR and RFC1918 space. A small credential-free control server tests
bridge HTTP independently of application startup and records whether Docker honored
its requested host-port mapping. This distinguishes network behavior from an app exit.
Before cleanup, QA records only selected container State/network fields and a bounded,
redacted fresh-fixture log tail. It never records Config/Env, mount or process arguments,
or user histories. The separate diagnostic artifact uploads even on failure; only a
successful acceptance job can provide the acceptance receipt to the publication gate.


## Explicit publication

After the required release-specific acceptance and any release HOLD are resolved,
run `publish-accepted-image` **from main**, with the successful build run ID:

```sh
gh workflow run publish-image.yml --repo WOOWTECH/Woow_k3s_pi_agent_package \
  --ref main -f candidate_run_id=BUILD_RUN_ID
```

This does not rebuild the image. The publisher reads the candidate and acceptance
artifacts from that exact successful run attempt, verifies their archive hashes,
and checks the registry manifest/config hashes, source revision and platforms.
Both `image` and `acceptance` jobs must have succeeded; failed, cancelled, skipped,
fork/PR, incomplete, mixed-attempt, or older-than-72-hour results are refused.
Rerun **all jobs** to obtain new acceptance; an old attempt's artifact cannot
satisfy a new attempt. The publisher's checked-out main must equal the tested SHA.

The GitHub mirror's current main is checked before and after each tag write.
Release-tag candidates must also still resolve to that same commit, match the
chart version, and have amd64 and arm64 acceptance. Follow the normal Gitea source
review/mirror workflow and check canonical main before requesting publication;
the GitHub job checks the mirror, not an inaccessible internal Gitea endpoint.

| Accepted candidate | Tags it may publish |
| --- | --- |
| Current main | `main`, `latest` |
| Current `vX.Y.Z`, equal to main/chart version | `X.Y.Z`, `X.Y`, `X`, `main`, `latest` |

`main/latest` keep their existing meaning: the latest deliberately published,
accepted main source. They are no longer a side effect of building. A full version
tag already pointing to another digest is refused before any writes; publication
of the same digest is idempotent. Deployments should pin a release digest.

Publication requests are serialised with a single concurrency group. The registry
does not offer a transaction across multiple tags and Git refs. If main advances
or a registry operation fails during publication, the job stops and records both
attempted and acknowledged tag writes in `image-publication.json`. A lost response
can leave an attempted write applied by the registry. There is **no blind rollback**;
inspect that receipt and the registry before retrying. Timeouts are 120 minutes
for building, 20 for isolated image acceptance, and 10 for publication; network
requests in the publisher are bounded to 25 seconds.

These controls apply to workflows in commits containing this change. Historical
tags carry historical workflow definitions: do not rerun pre-gate workflows or
create new release tags on pre-gate commits. This change does not rewrite those
tags, alter registry permissions, or retroactively certify their images.

PaaS candidate promotion remains a separate sealed approval process requiring
the authorised human's exact `/approve` comment. Root image publication neither
creates that signature nor bypasses that gate, and deploys no running service.
