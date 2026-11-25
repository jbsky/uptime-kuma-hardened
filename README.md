# Uptime Kuma Hardened

[![Build](https://github.com/jbsky/uptime-kuma-hardened/actions/workflows/build-push.yml/badge.svg)](https://github.com/jbsky/uptime-kuma-hardened/actions/workflows/build-push.yml)
[![Docker Hub](https://img.shields.io/docker/v/jbsky/uptime-kuma-hardened?sort=semver&label=Docker%20Hub)](https://hub.docker.com/r/jbsky/uptime-kuma-hardened)
[![Hardening](https://img.shields.io/badge/hardening-platine-blueviolet)](https://github.com/jbsky/uptime-kuma-hardened#hardening)

[Uptime Kuma](https://github.com/louislam/uptime-kuma) <!--v:uptime-kuma-hardened-->2.5.12<!--/v-->
in a `FROM scratch` image: static Go init, `tini` as PID 1, no shell, no
package manager. Meant for a Podman deployment on VyOS.

| | Official `louislam/uptime-kuma:2` image | This image |
|---|---|---|
| Size | 1.73 GB | **188 MB** |
| Base | Debian bookworm | `FROM scratch` |
| Shell, apt, sudo | yes | no |
| User | root | `3001:3001` |
| Tested under `cap_drop: ALL`, read-only, `no-new-privileges` | -- | yes (`scripts/test.sh`) |
| SQLite embedded by the native module | 3.41.1 (March 2023, prebuilt binary) | 3.53.4 (Alpine, dynamically linked) |
| Frontend `dist/` | shipped prebuilt by the release | rebuilt from the tag |

Trial on a copy of a production database (64 monitors, same version): every
monitor type in use -- http, keyword, dns, ping, port -- comes back green, and
every difference with the original instance is explained by the network
position of the test bench (the same target is unreachable from a bare Alpine
container on the same bridge). Resident memory: ~300 MiB after five minutes.

## What is built

| Component | Origin | Verification |
|---|---|---|
| Uptime Kuma (server + frontend) | archive of the GitHub tag, built here (`npm ci` on the lockfile, `vite build`; security overrides in production, see `SECURITY.md`) | sha256 pinned in `versions.json` |
| `@louislam/sqlite3` | built from its sources, linked to the system SQLite | the build fails if the module does not reference `libsqlite3.so` or is not BIND_NOW |
| `ping` (iputils) | built from source, without libcap, without setuid | GPG signature, fingerprint pinned in the Dockerfile |
| Node.js | Alpine `nodejs` package (a floor, like musl) | see below |
| init | static Go, `CGO_ENABLED=0` | `go vet` + `go test` |

**Why Node is not recompiled.** Measured on the Alpine 24.18.1 package: PIE,
full RELRO, BIND_NOW, NX stack, canary, `-O2`, LTO. Those are the flags we
would apply: recompiling adds none of them, grows the binary (OpenSSL and ICU
embedded instead of shared) and makes OpenSSL fixes wait for a Node release
rather than for Alpine. Alpine shipped the 24.18.1 security release two days
after upstream.

Libraries are copied from a closure resolved at build time (`lddtree`), never
`/lib` or `/usr/lib` wholesale. What no closure sees is copied by name: the
ICU data (read by path), OpenSSL's CA store, `zoneinfo`. The `prep` stage runs
node, Intl with a time zone, the sqlite3 module and ping **inside the final
rootfs** before publishing it.

`node_modules` is upstream's, with no package pruning: only source maps and
TypeScript declarations are removed (62 MB, never read at runtime). npm
dependencies with a known fix are forced through
[`npm-overrides.json`](npm-overrides.json), maintained by `npm-cve-watch`.

### What is left out

| Removed | Consequence |
|---|---|
| Chromium | no local "Real Browser" monitor -- a Remote Browser still works |
| Embedded MariaDB | `embedded-mariadb` is refused at startup; SQLite or an external MariaDB |
| apprise | no Apprise notification; the others (SMTP, Home Assistant, webhook...) are JavaScript |
| cloudflared | no built-in Cloudflare tunnel |
| tailscale, sip | monitors hidden in the interface (`UPTIME_KUMA_IS_CONTAINER=1`) |
| shell, sudo, nscd | Kuma logs "Failed to start nscd" at startup: harmless |

## Hardening

Tier **platine** (OCI label `security.hardening.tier`): a `FROM scratch` image
with no shell and no package manager, a non-root user, a static Go init behind
`tini` as PID 1, and binaries built with hardening flags.

- Non-root user `3001:3001`; tested under `cap_drop: ALL`, read-only rootfs
  and `no-new-privileges`.
- `ping` has **no capability** and no setuid bit: it opens an ICMP datagram
  socket, allowed by `net.ipv4.ping_group_range` (see [Usage](#usage)).
- Native code (sqlite3 module, iputils) built with `-fstack-protector-strong`,
  `-fstack-clash-protection`, `_FORTIFY_SOURCE=2`, full RELRO; the build fails
  if the sqlite3 module is not BIND_NOW.
- Libraries copied from a dependency closure resolved at build time
  (`lddtree`), never `/lib` or `/usr/lib` wholesale.
- The init checks with a real write that the data directory belongs to
  `3001:3001`, and refuses to start otherwise, with the fix in the message.

## Tags

Every image is published under three tags: `latest` (last build of `main`),
the upstream version alone, and the upstream version followed by a **revision
counter**. The first two are **overwritten in place** on every rebuild (Alpine
update, CVE fix, configuration change), and the build they pointed to can no
longer be pulled by them. **In production, pin the tag that carries the
counter.**

<!-- BEGIN:tags (generated by CI -- do not edit by hand) -->
| Image | Upstream version | Immutable tag to pin |
|-------|------------------|----------------------|
| `jbsky/uptime-kuma-hardened` | `2.5.12` | `2.5.12.1` |
<!-- END:tags -->

This table, the versions quoted in the text and the tags in the examples are
rendered by `update-readme-tags.sh` ([hardened-ci](https://github.com/jbsky/hardened-ci))
after each publication: do not edit them by hand.

The counter counts the commits that touch the image inputs (the `revision`
list of [`.github/hardened-ci.json`](.github/hardened-ci.json)) since the last
upstream version change, and restarts at `0` with each new upstream version. A
commit that only touches `.github/` does not increment it.

`docker.io` and `ghcr.io` publish the same tags with the same digest, for
`linux/amd64` only for now. Each registry keeps the last six immutable tags of
an image, so that superseded builds do not stay pullable: move your pin
forward.

`version-watch` checks upstream daily, bumps `versions.json` and republishes,
with no manual step: backups cover the residual risk, knex migrations
included.

## Usage

```yaml
services:
  uptime-kuma:
    image: jbsky/uptime-kuma-hardened:2.5.12.1
    read_only: true
    security_opt: [no-new-privileges:true]
    cap_drop: [ALL]
    sysctls:
      net.ipv4.ping_group_range: "3001 3001"
    tmpfs:
      - /tmp:nodev,nosuid,noexec,size=64m,mode=1777
    volumes:
      - ./data:/app/data
    ports:
      - "3001:3001"
```

Two things you cannot guess:

- **The data directory must belong to `3001:3001`.** The official image runs
  as root; a database it wrote is owned by `root`. Run
  `chown -R 3001:3001 <directory>` before switching. The init checks it with a
  real write and refuses to start otherwise, with the fix in the message.
- **`ping` has no capability.** It opens an ICMP datagram socket, which the
  kernel only grants to the groups covered by `net.ipv4.ping_group_range`.
  Docker opens it to everyone by default; **Podman restricts it to group 0**,
  hence the sysctl. Without it, the other monitors work and the init logs a
  warning at startup.

### VyOS

```
set container name uptime-kuma image 'docker.io/jbsky/uptime-kuma-hardened:2.5.12.1'
set container name uptime-kuma sysctl parameter net.ipv4.ping_group_range value '3001 3001'
set container name uptime-kuma memory '512'
set container name uptime-kuma volume uptime-data source '/config/containers/uptime-kuma/data'
set container name uptime-kuma volume uptime-data destination '/app/data'
```

The official image's `net-raw` capability is no longer needed. The data
directory must be moved to `3001:3001` before the first start.

## Running without a shell

- **Lost password**: `podman exec -it uptime-kuma /usr/bin/node extra/reset-password.js`
  (`extra/remove-2fa.js` for two-factor authentication).
- **Editing the database by hand**: there is no `sqlite3` in the container
  any more. Stop the container, work on `kuma.db` from the host, restart.

## Known upstream bug

A ping monitor whose "timeout" is 0 in the database (met on an existing
database: all its ping monitors were in that case) gets
`interval * 1000 * 0.8` -- **milliseconds** -- passed to `ping -w`, which
expects **seconds**: `ping -w 48000` for a 60 s interval. A target that stops
answering *without* sending back ICMP (packet dropped by a firewall) then
blocks the monitor for 13 hours instead of marking it DOWN. Present in 2.2.1
as in 2.5.5 (`server/model/monitor.js`), independent of the image. Workaround: <!-- version-fixe -->
open each ping monitor in edit mode and save it as is -- the interface
replaces a zero timeout with 10 s (`src/pages/EditMonitor.vue`).

## Build and test

```bash
make build   # build args come from versions.json
make test    # scripts/test.sh: read-only, cap_drop ALL, no-new-privileges
make scan    # Trivy, HIGH and CRITICAL
```

`scripts/test.sh` checks the absence of shell, the user, that every
`require()` of the server resolves, the database creation and every knex
migration, the frontend, a protected `/metrics`, ping without capability,
Intl with time zones, and the healthcheck.

Versions live only in [`versions.json`](versions.json): the Dockerfile has no
defaults, `make build` and CI pass them through `scripts/versions-build-args.py`,
and a bare `docker build` stops at the guard.

## Verification

Images are signed with [cosign](https://github.com/sigstore/cosign) (keyless,
GitHub OIDC) by the shared [hardened-ci](https://github.com/jbsky/hardened-ci)
pipeline. The certificate names that workflow and, in an extension, this
repository: the commands below require both.

```bash
# ghcr.io
cosign verify ghcr.io/jbsky/uptime-kuma-hardened:2.5.12.1 \
  --certificate-identity-regexp '^https://github.com/(jbsky/uptime-kuma-hardened|jbsky/hardened-ci)/' \
  --certificate-github-workflow-repository jbsky/uptime-kuma-hardened \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

# Docker Hub (the signature is stored on ghcr.io)
COSIGN_REPOSITORY=ghcr.io/jbsky/uptime-kuma-hardened \
  cosign verify docker.io/jbsky/uptime-kuma-hardened:2.5.12.1 \
  --certificate-identity-regexp '^https://github.com/(jbsky/uptime-kuma-hardened|jbsky/hardened-ci)/' \
  --certificate-github-workflow-repository jbsky/uptime-kuma-hardened \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Each published digest also carries a CycloneDX SBOM (the `prep` stage the
image is assembled from, plus its Go binaries), attested with cosign, and a
GitHub SLSA build provenance attestation. The pipeline lints, builds, scans the
`prep` stage with Trivy, tests the exact digest it is about to publish (image
manifest, dependency closure, functional tests), then promotes and signs it.
Base image digests follow upstream daily (`base-watch`), a fixable Alpine
package CVE triggers a rebuild (`cve-watch`), and the published image is
audited weekly (`security-audit`: Trivy, Grype, cosign). Audit status and
documented exceptions: [`SECURITY.md`](SECURITY.md).

## License

The contents of this repository (Dockerfile, `init.go`, scripts and CI) are
licensed under **Apache-2.0**, see [`LICENSE`](LICENSE). Copyright 2026 jbsky.

The software shipped in the image keeps its own license: **Uptime Kuma is
under MIT**, as are Node.js and tini; iputils is under GPL-2.0-or-later /
BSD-3-Clause. The two never mix: `init.go` is a separate program that executes
Node.js without being linked to it.

Contributions: see [`CONTRIBUTING.md`](CONTRIBUTING.md); a `Signed-off-by` is
required.
