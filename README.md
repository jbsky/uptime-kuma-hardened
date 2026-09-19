# Uptime Kuma Hardened

Image [Uptime Kuma](https://github.com/louislam/uptime-kuma) <!--v:uptime-kuma-hardened-->2.2.1<!--/v-->
durcie : `FROM scratch`, init Go statique, tini en PID 1, aucun shell, aucun
gestionnaire de paquets. Pensee pour un deploiement Podman sur VyOS.

|  | Image officielle `louislam/uptime-kuma:2` | Cette image |
|---|---|---|
| Taille | 1,73 Go | **188 Mo** |
| Base | Debian bookworm | `FROM scratch` |
| Shell, apt, sudo | oui | non |
| Utilisateur | root | `3001:3001` |
| Capacites requises | `NET_RAW` (ping) | **aucune** (`cap_drop: ALL`) |
| SQLite embarque par le module natif | 3.41.1 (mars 2023, binaire precompile) | 3.53.4 (Alpine, lie dynamiquement) |
| Frontend `dist/` | fourni tout fait par la release | reconstruit depuis le tag |

Essai sur une copie d'une base de production (64 sondes, meme version) : chaque
type de sonde utilise -- http, keyword, dns, ping, port -- remonte au vert, et
chaque ecart avec l'instance d'origine s'explique par la position reseau du banc
(la meme cible est injoignable depuis un conteneur Alpine nu sur le meme pont).
Memoire residente : ~300 Mio apres cinq minutes.

## Ce qui est embarque, et d'ou ca vient

| Composant | Origine | Verification |
|---|---|---|
| Uptime Kuma (serveur + frontend) | archive du tag GitHub, construite ici (`npm ci` sur le lockfile, `vite build`) | sha256 epingle dans `versions.json` |
| `@louislam/sqlite3` | compile depuis ses sources, lie au SQLite du systeme | le build echoue si le module ne reference pas `libsqlite3.so` ou n'est pas en BIND_NOW |
| `ping` (iputils) | compile depuis les sources, sans libcap, sans setuid | signature GPG, empreinte epinglee dans le Dockerfile |
| Node.js | paquet Alpine `nodejs` (plancher, comme musl) | voir ci-dessous |
| init | Go statique, `CGO_ENABLED=0` | `go vet` + `go test` |

**Pourquoi Node n'est pas recompile.** Mesure faite sur le paquet Alpine 24.18.1 :
PIE, Full RELRO, BIND_NOW, pile NX, canari, `-O2`, LTO. Ce sont les flags qu'on
appliquerait : recompiler n'en ajoute aucun, grossit le binaire (OpenSSL et ICU
embarques au lieu de partages) et fait attendre les correctifs OpenSSL d'une
release Node plutot que d'Alpine. Alpine a publie la release de securite 24.18.1
deux jours apres l'amont.

Les bibliotheques sont copiees depuis une cloture resolue au build (`lddtree`),
jamais `/lib` ni `/usr/lib` en bloc. Ce qu'aucune cloture ne voit est copie
nommement : les donnees ICU (lues par chemin), le magasin de CA d'OpenSSL,
`zoneinfo`. Le stage `prep` execute node, Intl avec un fuseau horaire, le module
sqlite3 et ping **dans le rootfs final** avant de le publier.

`node_modules` est celui de l'amont, sans elagage de paquets : seuls les source
maps et les declarations TypeScript sont retires (62 Mo, jamais lus a
l'execution).

## Ce qui n'y est pas

| Retire | Consequence |
|---|---|
| Chromium | pas de sonde « Real Browser » locale -- un navigateur distant (Remote Browser) reste utilisable |
| MariaDB embarque | `embedded-mariadb` refuse au demarrage ; SQLite ou MariaDB externe |
| apprise | pas de notification de type Apprise ; les autres (SMTP, Home Assistant, webhook...) sont en JavaScript |
| cloudflared | pas de tunnel Cloudflare integre |
| tailscale, sip | sondes masquees dans l'interface (`UPTIME_KUMA_IS_CONTAINER=1`) |
| shell, sudo, nscd | Kuma journalise « Failed to start nscd » au demarrage : sans effet |

## Execution

```yaml
services:
  uptime-kuma:
    image: jbsky/uptime-kuma-hardened:latest
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

Deux points qui ne se devinent pas :

- **Le repertoire de donnees doit appartenir a `3001:3001`.** L'image officielle
  tourne en root ; une base qu'elle a ecrite est en `root`. Faire
  `chown -R 3001:3001 <repertoire>` avant la bascule. L'init le verifie par une
  ecriture reelle et refuse de demarrer sinon, avec le correctif dans le message.
- **`ping` n'a aucune capacite.** Il ouvre un socket ICMP datagramme, que le noyau
  n'accorde qu'aux groupes couverts par `net.ipv4.ping_group_range`. Docker
  l'ouvre a tous par defaut ; **Podman le restreint au groupe 0**, d'ou le
  sysctl. Sans lui, les autres sondes marchent et l'init journalise un
  avertissement au demarrage.

### VyOS

```
set container name uptime-kuma image 'docker.io/jbsky/uptime-kuma-hardened:<tag>'
set container name uptime-kuma sysctl parameter net.ipv4.ping_group_range value '3001 3001'
set container name uptime-kuma memory '512'
set container name uptime-kuma volume uptime-data source '/config/containers/uptime-kuma/data'
set container name uptime-kuma volume uptime-data destination '/app/data'
```

La capacite `net-raw` de l'image officielle n'est plus necessaire. Le repertoire
de donnees doit etre passe en `3001:3001` avant le premier demarrage.

## Administration sans shell

- **Mot de passe perdu** : `podman exec -it uptime-kuma /usr/bin/node extra/reset-password.js`
  (`extra/remove-2fa.js` pour la double authentification).
- **Modifier la base a la main** : il n'y a plus de `sqlite3` dans le conteneur.
  Arreter le conteneur, travailler sur `kuma.db` depuis l'hote, redemarrer.

## Construire et tester

```bash
make build   # lit versions.json, aucune version n'est ecrite ailleurs
make test    # lance l'image en lecture seule, cap_drop ALL, no-new-privileges
```

`scripts/test.sh` verifie l'absence de shell, l'utilisateur, la creation de la
base et toutes les migrations knex, le frontend, `/metrics` protege, ping sans
capacite, Intl avec fuseaux et le healthcheck.

Architecture : `linux/amd64` seulement pour l'instant.

## Un defaut amont a connaitre

Une sonde ping dont le « timeout » vaut 0 en base (rencontre sur une base
existante : toutes ses sondes ping etaient dans ce cas) recoit
`interval * 1000 * 0.8` -- des **millisecondes** -- passe a `ping -w`, qui
attend des **secondes** : `ping -w 48000` pour un intervalle de 60 s. Une cible qui cesse de repondre *sans* renvoyer d'ICMP (paquet jete par un
pare-feu) bloque alors la sonde 13 heures au lieu de la passer DOWN.
Present en 2.2.1 comme en 2.5.5 (`server/model/monitor.js`), independant de
l'image. Contournement : ouvrir chaque sonde ping en edition et l'enregistrer
telle quelle -- l'interface remplace un timeout nul par 10 s
(`src/pages/EditMonitor.vue`).

## Licence

Ce depot est sous Apache-2.0. L'image embarque Uptime Kuma (MIT), Node.js (MIT),
iputils (GPL-2.0-or-later / BSD-3-Clause) et tini (MIT).
