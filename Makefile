.PHONY: help build up down logs ps test scan clean

DC := docker compose

# versions.json est la seule source de verite : le Dockerfile n'a aucun
# defaut, il faut donc lui passer chaque version.
KUMA_VERSION    := $(shell jq -r '."uptime-kuma"' versions.json)
KUMA_SHA256     := $(shell jq -r '."uptime-kuma_sha256"' versions.json)
IPUTILS_VERSION := $(shell jq -r .iputils versions.json)
IPUTILS_SHA256  := $(shell jq -r .iputils_sha256 versions.json)
export KUMA_VERSION KUMA_SHA256 IPUTILS_VERSION IPUTILS_SHA256

# CA du proxy SSL-bump, passee en secret BuildKit (jamais en couche). Absente
# hors du homelab : le Dockerfile la declare required=false.
# $(wildcard) rend une chaine vide si le fichier n'existe pas : compose se
# rabat alors sur /dev/null au lieu d'echouer sur un secret introuvable.
CA_CERTS ?= $(wildcard /usr/local/share/ca-certificates/bump.crt)
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
	@for v in "$(KUMA_VERSION)" "$(KUMA_SHA256)" "$(IPUTILS_VERSION)" "$(IPUTILS_SHA256)"; do \
	  test -n "$$v" -a "$$v" != "null" || { echo "versions.json illisible"; exit 1; }; done
	@echo "Build Uptime Kuma $(KUMA_VERSION) + iputils $(IPUTILS_VERSION) (versions.json)"
	DOCKER_BUILDKIT=1 $(DC) build --pull

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
