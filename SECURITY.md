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

## Exception connue : les dependances npm d'Uptime Kuma

**Releve du 2026-09-19** (Trivy, CRITICAL+HIGH) :

| Perimetre | CRITICAL | HIGH | Corrigeables en amont |
|---|--:|--:|--:|
| Stage `prep` (Alpine) | 0 | 0 | -- |
| Image publiee, Kuma 2.2.1 | 7 | 68 | 74 |
| Lockfile de Kuma 2.5.5, pour comparaison | 2 | 28 | 30 |

Toutes viennent du `package-lock.json` d'Uptime Kuma : ce sont les memes que
dans l'image officielle, qui installe le meme lockfile. CRITICAL en 2.2.1 :
`fast-xml-parser`, `jsonata`, `liquidjs`, `protobufjs`, `tar`.

Elles ne bloquent pas la publication, volontairement : le seul correctif est une
montee de Kuma, et une montee de Kuma applique des migrations de base sans
retour arriere -- elle se decide et se teste, elle ne se declenche pas sur un
scan. Reecrire le lockfile (`overrides` npm) ferait tourner Kuma sur un arbre
de dependances que l'amont n'a jamais teste.

Correctif : montee en 2.5.x, suivie par la veille de versions (issue
« [Veille] Version amont disponible »).
