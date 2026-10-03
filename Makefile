.PHONY: help build up down logs ps test scan clean

DC := docker compose

# versions.json est la seule source de verite : le Dockerfile n'a aucun
# defaut ; `make build` passe chaque version par scripts/versions-build-args.py,
# qui refuse une valeur absente, nulle ou vide.

# Derriere un proxy qui dechiffre le TLS : `make build CA_CERTS=/chemin/ca.crt`.
# La CA passe en secret BuildKit, jamais en couche ; le Dockerfile la declare
# required=false. Vide par defaut : compose se rabat sur /dev/null.
CA_CERTS ?=
export CA_CERTS

help:
	@echo "Cibles disponibles :"
	@echo "  make build   - Build de l'image hardenee (lit versions.json)"
	@echo "  make up      - Demarre le conteneur"
	@echo "  make down    - Arrete le conteneur"
	@echo "  make logs    - Journaux"
	@echo "  make ps      - Etat du conteneur"
	@echo "  make test    - Tests fonctionnels (scripts/test.sh)"
	@echo "  make scan    - Scan Trivy de l'image"
	@echo "  make clean   - Supprime volume + image"

build:
	@args=$$(./scripts/versions-build-args.py --docker) \
	  && echo "Build depuis versions.json : $$args" \
	  && DOCKER_BUILDKIT=1 $(DC) build --pull $$args

up:
	$(DC) up -d

down:
	$(DC) down

logs:
	$(DC) logs -f --tail=200

ps:
	$(DC) ps

test:
	./scripts/test.sh localhost/uptime-kuma-hardened:latest

scan:
	trivy image --severity CRITICAL,HIGH localhost/uptime-kuma-hardened:latest

clean:
	$(DC) down -v --rmi local
