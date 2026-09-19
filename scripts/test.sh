#!/bin/bash
# Tests fonctionnels de uptime-kuma-hardened, sur un conteneur lance avec les
# contraintes de production (lecture seule, cap_drop ALL, no-new-privileges).
#
#   scripts/test.sh [image]
set -eu

IMAGE="${1:-localhost/uptime-kuma-hardened:latest}"
NAME="kuma-test-$$"
PORT="${KUMA_TEST_PORT:-13001}"
BASE="http://127.0.0.1:${PORT}"
PASS=0
FAIL=0

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }

cleanup() {
    docker rm -f "${NAME}" > /dev/null 2>&1 || true
    docker volume rm "${NAME}-data" > /dev/null 2>&1 || true
}
trap cleanup EXIT

# Attend qu'une URL reponde 200, sans echouer sur les premiers refus.
wait_http() {
    local url="$1" tries="${2:-90}"
    for _ in $(seq "${tries}"); do
        if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "${url}" || true)" = "200" ]; then
            return 0
        fi
        sleep 1
    done
    return 1
}

echo ""
echo "=== uptime-kuma-hardened -- ${IMAGE} ==="

echo ""
echo "--- Image ---"
if docker run --rm --entrypoint /bin/sh "${IMAGE}" -c true > /dev/null 2>&1; then
    fail "aucun /bin/sh dans l'image"
else
    pass "aucun /bin/sh dans l'image"
fi
user="$(docker image inspect -f '{{.Config.User}}' "${IMAGE}")"
if [ "${user}" = "3001:3001" ]; then pass "USER 3001:3001"; else fail "USER = ${user}"; fi
tier="$(docker image inspect -f '{{index .Config.Labels "security.hardening.tier"}}' "${IMAGE}")"
if [ "${tier}" = "platine" ]; then pass "label security.hardening.tier=platine"; else fail "label tier = ${tier}"; fi

# Chaque require() du serveur, types de sonde charges a la demande compris,
# doit se resoudre dans l'image : c'est le garde de l'elagage de node_modules,
# que le demarrage seul n'exerce pas (une sonde mqtt ne charge son module
# qu'a la premiere verification).
unresolved="$(docker run --rm --entrypoint /usr/bin/node -w /app "${IMAGE}" -e '
const fs = require("fs"), path = require("path"), bad = new Set();
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) { walk(p); continue; }
    if (!p.endsWith(".js")) continue;
    for (const m of fs.readFileSync(p, "utf8").matchAll(/require\("([^".][^"]*)"\)/g)) {
      try { require.resolve(m[1], { paths: [path.dirname(p)] }); } catch (e) { bad.add(m[1]); }
    }
  }
})("/app/server");
process.stdout.write([...bad].join(" "));' 2>&1 || echo "node en echec")"
if [ -z "${unresolved}" ]; then
    pass "tous les require() de server/ se resolvent"
else
    fail "require() non resolus : ${unresolved}"
fi

echo ""
echo "--- Demarrage (lecture seule, cap_drop ALL, no-new-privileges) ---"
docker volume create "${NAME}-data" > /dev/null
# Le volume nomme est cree root:root ; l'image le prepare en 3001:3001 sous
# /app/data, que docker recopie a la premiere montee.
docker run -d --name "${NAME}" \
    --read-only --tmpfs /tmp:nodev,nosuid,noexec,size=64m,mode=1777 \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --sysctl net.ipv4.ping_group_range="3001 3001" \
    -v "${NAME}-data:/app/data" \
    -p "127.0.0.1:${PORT}:3001" \
    "${IMAGE}" > /dev/null

if wait_http "${BASE}/api/entry-page"; then
    pass "GET /api/entry-page repond 200"
else
    fail "GET /api/entry-page ne repond pas"
    docker logs "${NAME}" 2>&1 | tail -30
    exit 1
fi

echo ""
echo "--- Base SQLite : creation + migrations knex ---"
# Premier demarrage : Kuma attend le choix de la base. sqlite cree kuma.db
# depuis le gabarit puis joue toutes les migrations -- c'est le chemin qui
# exerce le module natif lie au SQLite d'Alpine.
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -H 'Content-Type: application/json' \
    -d '{"dbConfig":{"type":"sqlite"}}' "${BASE}/setup-database")"
if [ "${code}" = "200" ]; then pass "POST /setup-database sqlite (HTTP 200)"; else fail "POST /setup-database : HTTP ${code}"; fi

ok=0
for _ in $(seq 120); do
    if curl -s --max-time 3 "${BASE}/api/entry-page" | grep -q '"type":"entryPage"'; then
        ok=1
        break
    fi
    sleep 1
done
if [ "${ok}" = 1 ]; then
    pass "serveur principal demarre sur la base migree"
else
    fail "le serveur principal n'a pas demarre"
    docker logs "${NAME}" 2>&1 | tail -30
fi

if docker logs "${NAME}" 2>&1 | grep -q -i -E 'migrat.*(error|fail)|SQLITE_ERROR'; then
    fail "erreur de migration dans les journaux"
else
    pass "aucune erreur de migration dans les journaux"
fi

body="$(curl -s --max-time 5 "${BASE}/dashboard")"
if echo "${body}" | grep -q '<title>Uptime Kuma</title>'; then
    pass "frontend servi (dist/ construit depuis les sources)"
else
    fail "frontend absent de /dashboard"
fi

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${BASE}/metrics")"
if [ "${code}" = "401" ]; then pass "/metrics exige une authentification (401)"; else fail "/metrics : HTTP ${code}"; fi

echo ""
echo "--- Outils lances par Kuma, dans le conteneur contraint ---"
if docker exec "${NAME}" /bin/ping -n -c 1 -W 2 127.0.0.1 > /dev/null 2>&1; then
    pass "ping sans capacite (socket ICMP datagramme)"
else
    fail "ping echoue dans le conteneur"
fi
tz="$(docker exec "${NAME}" /usr/bin/node -e 'process.stdout.write(new Intl.DateTimeFormat("en-US",{timeZone:"Asia/Tokyo",timeZoneName:"short"}).format(0))' 2>&1 || true)"
if echo "${tz}" | grep -q 'GMT+9'; then pass "Intl + fuseaux ICU (${tz})"; else fail "Intl : ${tz}"; fi

hc="$(docker exec "${NAME}" /usr/local/bin/init --healthcheck > /dev/null 2>&1 && echo 0 || echo 1)"
if [ "${hc}" = 0 ]; then pass "init --healthcheck sort en 0"; else fail "init --healthcheck sort en ${hc}"; fi

uid="$(docker exec "${NAME}" /usr/bin/node -e 'process.stdout.write(process.getuid()+":"+process.getgid())')"
if [ "${uid}" = "3001:3001" ]; then pass "node tourne en 3001:3001"; else fail "node tourne en ${uid}"; fi

echo ""
echo "=== Resultat : ${PASS} reussis, ${FAIL} en echec ==="
[ "${FAIL}" -eq 0 ]
