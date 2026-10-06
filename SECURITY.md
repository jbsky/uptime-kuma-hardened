# Securite

## Signaler une vulnerabilite

Par un [avis de securite prive GitHub](https://github.com/jbsky/uptime-kuma-hardened/security/advisories/new),
pas par une issue publique.

Une vulnerabilite d'Uptime Kuma lui-meme (serveur, frontend, dependances npm)
releve de l'amont : <https://github.com/louislam/uptime-kuma/security>. Elle est
corrigee ici par une montee de version dans `versions.json`.

## Ce que la CI bloque, et ce qu'elle rapporte seulement

| Perimetre | Scanne | Effet |
|---|---|---|
| Paquets Alpine copies dans l'image (node, OpenSSL, SQLite, ICU...) | Trivy sur le stage `prep`, a chaque build | **bloque** sur un CRITICAL corrigeable |
| Dependances npm de Kuma (`/app/node_modules`) | Trivy sur l'image finale a chaque publication ; Trivy + Grype chaque mardi | rapport SARIF + une issue tenue a jour |

## Dependances npm d'Uptime Kuma : overrides et derogations

**Decision du 2026-10-06**, qui renverse celle du 2026-09-19 (« seule une
montee de Kuma corrige ») : en 2.5.5, derniere version de l'amont, l'audit
restait rouge sur 42 alertes HIGH/CRITICAL corrigeables, toutes dans le
`package-lock.json` d'Uptime Kuma (issue #8). Attendre l'amont laissait des
correctifs publies hors de l'image pendant des semaines.

### Overrides (`npm-overrides.json`)

Le stage `deps` reprend le lockfile de l'amont, puis force une version
corrigee pour chaque paquet liste, dans la **meme majeure** (correctif ou
mineure). Chaque entree nomme les avis qu'elle corrige. Deux gardes, au build
(`scripts/npm-overrides.js`) :

- `apply` echoue si l'amont a rattrape la version epinglee (ou si le paquet a
  disparu) : l'override se retire, il ne retrograde jamais ;
- `verify` echoue si une copie visee n'est pas a la version epinglee apres
  `npm install`.

Le `.npmrc` de l'amont reste en vigueur : `min-release-age=14`, aucune version
publiee depuis moins de 14 jours n'entre dans l'image. Ecart le plus large :
`mysql2` 3.11 -> 3.24 (stockage MariaDB seulement ; en SQLite il n'est pas
charge).

Le prix accepte : Kuma tourne sur un arbre de dependances que l'amont n'a pas
teste tel quel. `scripts/test.sh` et le deploiement le valident ici.

### Derogations (`.trivyignore`, `.grype.yaml`)

Ce qui n'a de correctif que dans une nouvelle majeure n'est pas force :

| Paquet | Correctif | Pourquoi la derogation |
|---|---|---|
| `tar` 6.2.1 | 7.x | jamais charge par le serveur : seuls `extra/download-dist.js` (absent de l'image) et node-gyp au build l'utilisent |
| `nodemailer` 7.0.13 | 8.x a 10.x | charge (notifications et sonde SMTP), mais Kuma n'utilise ni l'option `raw` ni OAuth2, et les adresses analysees viennent de la configuration admin |

Les entrees de `.trivyignore` expirent le **2027-01-06** : passe cette date,
l'audit redevient rouge et la derogation se rejustifie ou tombe. Grype n'a
pas d'expiration ; les deux listes se retirent ensemble. Toute alerte
nouvelle sur ces paquets reste visible (derogation par identifiant, pas par
paquet).
