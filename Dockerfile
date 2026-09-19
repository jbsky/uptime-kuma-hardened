# syntax=docker/dockerfile:1
# =====================================================================
#  Uptime Kuma Hardened -- Tier Platine (FROM scratch)
#  fetch -> web -> deps -> ping -> gobuilder -> prep -> scratch
# =====================================================================
# Pas de valeur par defaut, volontairement : versions.json est la seule source
# de verite. Un defaut ici diverge en silence (varnish-hardened a construit
# une 7.7.3 pendant des mois sous le nom d'une 8.0.0). Le Makefile et la CI
# passent ces ARG ; un `docker build` nu echoue avec un message.
ARG KUMA_VERSION
# GitHub ne publie ni signature ni somme pour l'archive d'un tag : l'integrite
# repose sur un sha256 epingle dans versions.json, recalcule dans le meme
# commit que la version.
ARG KUMA_SHA256
ARG IPUTILS_VERSION
ARG IPUTILS_SHA256
# Documentation seulement : les FROM ci-dessous epinglent tag ET digest en
# litteral, cet ARG ne pilote rien.
ARG ALPINE_VERSION=3.24

# --- fetch : sources verifiees, rien d'autre ---------------------------
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS fetch

ARG KUMA_VERSION
ARG KUMA_SHA256
ARG IPUTILS_VERSION
ARG IPUTILS_SHA256
# iputils signe ses archives (Petr Vorel, mainteneur). La cle est committee
# dans keys/ et son empreinte epinglee ici : importer une cle puis verifier
# avec elle ne prouve rien, c'est l'empreinte attendue dans VALIDSIG qui ancre.
# Recoupee le 2026-09-19 sur keys.openpgp.org et sur le compte GitHub du
# mainteneur (pevik).
ARG IPUTILS_FPR=2016FEA4858B1C36B32E833AC0DEC2EE72F33A5F

RUN test -n "${KUMA_VERSION}" -a -n "${KUMA_SHA256}" \
         -a -n "${IPUTILS_VERSION}" -a -n "${IPUTILS_SHA256}" \
    || { echo "KUMA_VERSION, KUMA_SHA256, IPUTILS_VERSION et IPUTILS_SHA256 sont requis : make build (lit versions.json)" >&2; exit 1; }

# Proxy SSL-bump : depots apk en HTTP, CA interne en secret BuildKit (jamais
# en couche de l'image finale ; ce stage n'est pas publie).
RUN sed -i 's|https://|http://|g' /etc/apk/repositories
RUN --mount=type=secret,id=ca-certs,required=false \
    if [ -f /run/secrets/ca-certs ]; then \
      cat /run/secrets/ca-certs >> /etc/ssl/certs/ca-certificates.crt; \
    fi \
 && apk add --no-cache curl gnupg

WORKDIR /src
RUN curl -fsSL "https://github.com/louislam/uptime-kuma/archive/refs/tags/${KUMA_VERSION}.tar.gz" -o kuma.tar.gz \
 && printf '%s  kuma.tar.gz\n' "${KUMA_SHA256}" > kuma.sha256 \
 && sha256sum -c kuma.sha256 \
 && mkdir kuma \
 && tar -xzf kuma.tar.gz -C kuma --strip-components=1 \
 && rm kuma.tar.gz kuma.sha256

COPY keys/iputils-2016FEA4858B1C36B32E833AC0DEC2EE72F33A5F.asc /tmp/iputils.asc
RUN base="https://github.com/iputils/iputils/releases/download/${IPUTILS_VERSION}/iputils-${IPUTILS_VERSION}.tar.xz" \
 && curl -fsSL "${base}" -o iputils.tar.xz \
 && curl -fsSL "${base}.asc" -o iputils.tar.xz.asc \
 && printf '%s  iputils.tar.xz\n' "${IPUTILS_SHA256}" > iputils.sha256 \
 && sha256sum -c iputils.sha256 \
 && GNUPGHOME="$(mktemp -d)" && export GNUPGHOME \
 && gpg --batch --import /tmp/iputils.asc \
 && gpg --batch --status-file /tmp/gpg.status --verify iputils.tar.xz.asc iputils.tar.xz \
 && grep -q "^\[GNUPG:\] VALIDSIG .* ${IPUTILS_FPR}\$" /tmp/gpg.status \
 && gpgconf --kill gpg-agent \
 && rm -rf "${GNUPGHOME}" /tmp/gpg.status /tmp/iputils.asc iputils.tar.xz.asc iputils.sha256 \
 && mkdir iputils \
 && tar -xJf iputils.tar.xz -C iputils --strip-components=1 \
 && rm iputils.tar.xz

# --- web : frontend construit depuis les sources -----------------------
# L'image officielle ne compile pas dist/ : elle le recoit tout fait du
# processus de release. Ici vite tourne sur les sources du tag, avec les
# devDependencies du lockfile, dans un stage qui n'est pas publie.
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS web

RUN sed -i 's|https://|http://|g' /etc/apk/repositories
RUN --mount=type=secret,id=ca-certs,required=false \
    if [ -f /run/secrets/ca-certs ]; then \
      cat /run/secrets/ca-certs >> /etc/ssl/certs/ca-certificates.crt; \
    fi \
 && apk add --no-cache nodejs npm

COPY --from=fetch /src/kuma /src/kuma
WORKDIR /src/kuma
# --ignore-scripts : aucun script d'installation des ~1000 paquets de dev ne
# s'execute. esbuild et rollup trouvent leur binaire de plateforme sans eux.
RUN npm ci --no-audit --no-fund --ignore-scripts \
 && npm run build \
 && test -s dist/index.html

# --- deps : node_modules de production, module natif compile ici -------
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS deps

RUN sed -i 's|https://|http://|g' /etc/apk/repositories
RUN --mount=type=secret,id=ca-certs,required=false \
    if [ -f /run/secrets/ca-certs ]; then \
      cat /run/secrets/ca-certs >> /etc/ssl/certs/ca-certificates.crt; \
    fi \
 && apk add --no-cache nodejs nodejs-dev npm python3 make g++ sqlite-dev binutils

ENV CFLAGS="-O2 -fstack-protector-strong -fstack-clash-protection -fPIC -D_FORTIFY_SOURCE=2 -Wformat -Werror=format-security" \
    CXXFLAGS="-O2 -fstack-protector-strong -fstack-clash-protection -fPIC -D_FORTIFY_SOURCE=2 -Wformat -Werror=format-security" \
    LDFLAGS="-Wl,-z,relro,-z,now,-z,noexecstack"

WORKDIR /app
COPY --from=fetch /src/kuma/package.json /src/kuma/package-lock.json /src/kuma/.npmrc ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts

# @louislam/sqlite3 telecharge par defaut un binaire precompile depuis GitHub,
# qui embarque SQLite 3.41.1 (mars 2023). Il est ici compile depuis ses
# sources et lie au SQLite d'Alpine (--sqlite=/usr) : la bibliotheque est deja
# dans la cloture de node, et Alpine la corrige a son rythme. Les en-tetes de
# node viennent du meme paquet que le runtime (--nodedir), pas d'un
# telechargement.
RUN npm_config_build_from_source=true npm_config_sqlite=/usr npm_config_nodedir=/usr \
    npm rebuild @louislam/sqlite3 \
 && addon="$(find node_modules/@louislam/sqlite3/lib/binding -name node_sqlite3.node)" \
 && test -n "${addon}" \
 && readelf -d "${addon}" > /tmp/addon.dyn \
 && grep -q 'NEEDED.*\[libsqlite3\.so' /tmp/addon.dyn \
 && grep -q BIND_NOW /tmp/addon.dyn \
 && strip --strip-unneeded "${addon}" \
 && rm -rf node_modules/@louislam/sqlite3/build-tmp-napi-v* node_modules/@louislam/sqlite3/deps \
           node_modules/@louislam/sqlite3/src /tmp/addon.dyn

# Aucun autre .node que celui compile ci-dessus : un binaire precompile
# (glibc, autre architecture) passerait sinon dans l'image sans que personne
# ne l'ait construit. Ce garde a deja servi : node-pre-gyp laisse deux copies
# intermediaires dans build-tmp-napi-v6/, pas dans build/.
RUN find node_modules -name '*.node' -type f > /tmp/addons \
 && test "$(wc -l < /tmp/addons)" -eq 1 \
 && grep -q 'node_modules/@louislam/sqlite3/lib/binding/' /tmp/addons \
 && rm /tmp/addons

# Ni les source maps ni les declarations TypeScript ne sont lues au runtime
# (node n'ouvre un .map qu'avec --enable-source-maps) : 62 Mo sur 153 mesures
# le 2026-09-19. Aucun paquet n'est retire -- l'elagage des paquets inutiles
# (mssql et @azure, mongodb, kafkajs...) forkerait l'amont a chaque version.
RUN find node_modules -type f \
      \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete

# --- ping : iputils depuis les sources ---------------------------------
# @louislam/ping lance /bin/ping (chemin en dur quand `command -v` est
# indisponible, ce qui est le cas sans shell) et parse la sortie d'iputils :
# un ping busybox ne convient pas. Compile sans libcap, sans setuid et sans
# capacite de fichier : il ouvre un socket ICMP datagramme, autorise par
# net.ipv4.ping_group_range (cf. README). Alpine applique un seul correctif
# (getopt_long, pour les options placees apres l'hote) : pas un correctif de
# securite, et @louislam/ping met l'hote en dernier.
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS ping

RUN sed -i 's|https://|http://|g' /etc/apk/repositories \
 && apk add --no-cache build-base meson linux-headers

ENV CFLAGS="-O2 -fstack-protector-strong -fstack-clash-protection -fPIE -D_FORTIFY_SOURCE=2 -Wformat -Werror=format-security" \
    LDFLAGS="-Wl,-z,relro,-z,now,-z,noexecstack -pie"

COPY --from=fetch /src/iputils /src/iputils
WORKDIR /src/iputils
# buildtype=plain : meson n'ajoute aucun -O, les CFLAGS ci-dessus font foi.
RUN meson setup build --buildtype=plain -Db_pie=true \
      -DBUILD_PING=true -DBUILD_ARPING=false -DBUILD_CLOCKDIFF=false \
      -DBUILD_TRACEPATH=false -DBUILD_MANS=false -DBUILD_HTML_MANS=false \
      -DUSE_CAP=false -DUSE_IDN=false -DUSE_GETTEXT=false \
      -DNO_SETCAP_OR_SUID=true -DSKIP_TESTS=true \
 && meson compile -C build \
 && install -D -m 0755 build/ping/ping /out/bin/ping \
 && strip /out/bin/ping \
 && readelf -d /out/bin/ping > /tmp/ping.dyn \
 && grep -q 'FLAGS_1.*PIE' /tmp/ping.dyn \
 && grep -q BIND_NOW /tmp/ping.dyn \
 && rm /tmp/ping.dyn

# --- gobuilder : init statique (entrypoint + healthcheck + setup-dirs) -
FROM --platform=$BUILDPLATFORM golang:1.26-alpine@sha256:51a7c389a5ddaf82f527191a1e9bff9928655130a44e4975dd1d7e0acf59f1ae AS gobuilder
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY go.mod init.go ./
RUN CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" \
    go build -ldflags='-s -w' -trimpath -o /init .

# --- prep : arborescence runtime, cloture resolue au build -------------
# Node vient du paquet Alpine : c'est le plancher du parc (comme musl et
# libstdc++), pas le service. Le code du service, lui, est construit depuis
# le tag dans web et deps. Mesure du 2026-09-19 : le paquet est deja PIE,
# Full RELRO, BIND_NOW, NX, canari, -O2 et LTO -- recompiler n'apporte aucun
# flag, grossit le binaire (OpenSSL et ICU embarques) et lie les correctifs
# OpenSSL au rythme des releases Node au lieu de celui d'Alpine.
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS prep

RUN sed -i 's|https://|http://|g' /etc/apk/repositories \
 && apk add --no-cache nodejs tini-static ca-certificates tzdata lddtree \
 && addgroup -S -g 3001 kuma \
 && adduser -S -D -H -u 3001 -G kuma -h /app -s /sbin/nologin kuma

COPY --from=ping /out/bin/ping /stage/bin/ping
COPY --from=deps /app/node_modules/@louislam/sqlite3/lib/binding/ /stage/addons/

# Racines : node, ping, et les modules natifs -- charges par dlopen, donc
# invisibles depuis node, ils sont passes explicitement et l'enumeration
# echoue si elle revient vide. Les racines elles-memes sont retirees de la
# liste (lddtree les reimprime) et copiees a part, a leur place finale.
RUN find /stage/addons -name '*.node' -type f > /tmp/addons \
 && test -s /tmp/addons \
 && { lddtree -l /usr/bin/node /stage/bin/ping; \
      xargs lddtree -l < /tmp/addons; } \
      > /tmp/closure.list 2> /tmp/closure.err \
 && if grep -q 'Not found' /tmp/closure.list /tmp/closure.err; then \
      echo "cloture incomplete -- une dependance manque a ce stage :" >&2; \
      grep 'Not found' /tmp/closure.list /tmp/closure.err >&2; \
      exit 1; \
    fi \
 && sort -u /tmp/closure.list -o /tmp/closure.list \
 && grep -v -E '^/usr/bin/node$|^/stage/' /tmp/closure.list > /tmp/closure.deps \
 && mkdir -p /rootfs \
 && tar -cf /tmp/closure.tar -T /tmp/closure.deps \
 && tar -xf /tmp/closure.tar -C /rootfs \
 && rm -f /tmp/closure.list /tmp/closure.deps /tmp/closure.err /tmp/closure.tar /tmp/addons

# Ce qu'aucune cloture ne voit, parce que ce n'est pas une dependance ELF :
#   /usr/share/icu     donnees ICU, lues par chemin (node est configure
#                      --with-icu-default-data-dir) : sans elles, Intl et les
#                      fuseaux horaires cassent sans erreur au demarrage
#   /etc/ssl/cert.pem  node est configure --openssl-use-def-ca-store : il lit
#                      le magasin d'OpenSSL, pas une liste compilee
#   /usr/share/zoneinfo  TZ cote musl
RUN mkdir -p /rootfs/usr/bin /rootfs/bin /rootfs/sbin /rootfs/etc/ssl/certs /rootfs/usr/share \
 && cp /usr/bin/node /rootfs/usr/bin/node \
 && cp /stage/bin/ping /rootfs/bin/ping \
 && ln -s ping /rootfs/bin/ping6 \
 && cp /sbin/tini-static /rootfs/sbin/tini \
 && test -d /usr/share/icu \
 && cp -a /usr/share/icu /rootfs/usr/share/ \
 && cp -a /usr/share/zoneinfo /rootfs/usr/share/ \
 && cp /etc/ssl/certs/ca-certificates.crt /rootfs/etc/ssl/certs/ \
 && ln -s certs/ca-certificates.crt /rootfs/etc/ssl/cert.pem \
 && grep -E '^(root|nobody|kuma):' /etc/passwd > /rootfs/etc/passwd \
 && grep -E '^(root|nobody|kuma):' /etc/group > /rootfs/etc/group

# Preuve au build, pas au premier demarrage : node, Intl avec un fuseau,
# le module sqlite3 et ping s'executent dans /rootfs tel qu'il sera publie.
# Le module est copie le temps du test puis retire (il arrive par /app).
RUN addon="$(find /stage/addons -name '*.node' -type f)" \
 && cp "${addon}" /rootfs/probe.node \
 && chroot /rootfs /usr/bin/node -e ' \
      const s = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", timeZoneName: "short" }).format(0); \
      if (!/GMT\+1|CET/.test(s)) { console.error("fuseau non resolu : " + s); process.exit(1); } \
      const m = { exports: {} }; process.dlopen(m, "/probe.node"); \
      if (typeof m.exports.Database !== "function") { console.error("sqlite3 inutilisable"); process.exit(1); } \
      require("crypto").createHash("sha256"); \
      console.log("node " + process.version + " | icu " + process.versions.icu + " | sqlite3 OK | " + s);' \
 && chroot /rootfs /bin/ping -V \
 && rm /rootfs/probe.node

# --- Final : FROM scratch -----------------------------------------------
FROM scratch

ARG KUMA_VERSION
# image.licenses decrit le logiciel embarque : Uptime Kuma (MIT), Node.js
# (MIT et ses dependances), iputils (GPL-2.0-or-later pour ping, BSD pour
# certaines parties), tini (MIT). Ce depot lui-meme est en Apache-2.0.
LABEL org.opencontainers.image.title="uptime-kuma-hardened" \
      org.opencontainers.image.description="Uptime Kuma ${KUMA_VERSION} hardened (Tier Platine: FROM scratch, Go init, tini PID 1)" \
      org.opencontainers.image.vendor="jbsky" \
      org.opencontainers.image.version="${KUMA_VERSION}" \
      org.opencontainers.image.source="https://github.com/jbsky/uptime-kuma-hardened" \
      org.opencontainers.image.licenses="MIT AND GPL-2.0-or-later AND BSD-3-Clause" \
      security.hardening.tier="platine"

# Runtime : node + ping + tini, leur cloture, ICU, CA, zoneinfo, passwd.
COPY --link --from=prep /rootfs/ /
COPY --link --from=gobuilder /init /usr/local/bin/init

# L'application, fichier par fichier : seulement ce que le serveur charge.
#   src/util.js      requis par ~110 modules du serveur
#   db/              gabarit kuma.db + migrations knex
#   extra/*.js       outils de secours (reset-password, remove-2fa) : sans
#                    shell, `podman exec ... node extra/reset-password.js`
#                    est le seul chemin
#   extra/rdap-dns.json, extra/push-examples/  lus par le serveur
COPY --link --from=deps /app/node_modules/ /app/node_modules/
COPY --link --from=fetch /src/kuma/package.json /app/package.json
COPY --link --from=fetch /src/kuma/server/ /app/server/
COPY --link --from=fetch /src/kuma/db/ /app/db/
COPY --link --from=fetch /src/kuma/src/util.js /app/src/util.js
COPY --link --from=fetch /src/kuma/extra/rdap-dns.json /src/kuma/extra/reset-password.js /src/kuma/extra/remove-2fa.js /app/extra/
COPY --link --from=fetch /src/kuma/extra/push-examples/ /app/extra/push-examples/
COPY --link --from=web /src/kuma/dist/ /app/dist/

RUN ["/usr/local/bin/init", "--setup-dirs"]

# UPTIME_KUMA_IS_CONTAINER=1 masque dans l'interface les sondes qui exigent
# un binaire absent ici (tailscale-ping, sip-options). Contrepartie : Kuma
# tente `sudo service nscd start` au demarrage et journalise un echec
# ("Failed to start nscd") -- sans shell, l'appel echoue sans effet.
ENV NODE_ENV=production \
    UPTIME_KUMA_IS_CONTAINER=1 \
    PATH="/usr/bin:/bin:/usr/local/bin:/sbin"

USER 3001:3001
WORKDIR /app
EXPOSE 3001

HEALTHCHECK --interval=60s --timeout=30s --start-period=180s --retries=5 \
    CMD ["/usr/local/bin/init", "--healthcheck"]

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/init"]
