# syntax=docker/dockerfile:1
# Built only by run.mjs from a run-owned context: harness.tar (the committed harness revision), runtime/ (frozen
# stock-host lockfiles), subject.tar (git archive of the subject commit; artifact target only) and plugin.tgz
# (the packed candidate; runtime target only). No credentials, host homes or sockets ever enter a build.

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG BUN_VERSION=1.4.2

# ---- Archived subject build: core first, root-local hive-core resolution checked, then pack.
FROM ${NODE_IMAGE} AS builder
ARG NODE_IMAGE
ARG BUN_VERSION
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
RUN npm install -g "bun@${BUN_VERSION}" && bun --version
ADD harness.tar /ic/harness/
ADD subject.tar /src/
WORKDIR /src
RUN bun install --frozen-lockfile
RUN cd packages/hive-core && bun run build
RUN node /ic/harness/fixture.ts build-check-core > /tmp/core-check.json
RUN cd packages/opencode-hive && bun run build
RUN mkdir /out && cd packages/opencode-hive && npm pack --json --pack-destination /out > /tmp/pack.json \
 && mv /out/oc-arkive-*.tgz /out/oc-arkive.tgz
RUN NODE_IMAGE="${NODE_IMAGE}" node /ic/harness/fixture.ts build-report > /out/build-report.json

FROM scratch AS artifact
COPY --from=builder /out/oc-arkive.tgz /out/build-report.json /

# ---- Runtime: frozen stock hosts, then the normally npm-installed packed plugin, then the harness.
FROM ${NODE_IMAGE} AS runtime
ARG NODE_IMAGE
ARG PLUGIN_SHA256
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
# ripgrep is preinstalled because both hosts otherwise download it at first use, which fails without network and
# would add an unpinned runtime download to every paid case.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
 && rm -rf /var/lib/apt/lists/*
COPY runtime/ /opt/ic/
RUN cd /opt/ic/v1 && npm ci --no-audit --no-fund && /opt/ic/v1/node_modules/.bin/opencode --version
RUN cd /opt/ic/v2 && npm ci --no-audit --no-fund && /opt/ic/v2/node_modules/.bin/opencode2 --version
COPY plugin.tgz /opt/ic/pkg/oc-arkive.tgz
RUN test -n "${PLUGIN_SHA256}" && echo "${PLUGIN_SHA256}  /opt/ic/pkg/oc-arkive.tgz" | sha256sum -c -
RUN mkdir -p /opt/ic/plugin && cd /opt/ic/plugin && printf '{"name":"ic-plugin","private":true}\n' > package.json \
 && npm install --save-exact --no-audit --no-fund /opt/ic/pkg/oc-arkive.tgz @opencode-ai/plugin@1.18.30 effect@4.0.0-rc.112
ADD harness.tar /opt/ic/harness/
RUN NODE_IMAGE="${NODE_IMAGE}" node /opt/ic/harness/fixture.ts runtime-report > /opt/ic/runtime-report.json
USER 1000:1000
WORKDIR /work
