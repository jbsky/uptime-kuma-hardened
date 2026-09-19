# Contribuer

Deux regles, pas plus.

## 1. Signer ses commits (`Signed-off-by`)

Chaque commit doit porter la ligne :

```
Signed-off-by: Prenom Nom <adresse@example.com>
```

`git commit -s` l'ajoute pour vous.

C'est le [Developer Certificate of Origin](https://developercertificate.org/) :
vous attestez avoir le droit de soumettre ce code sous la licence du depot.

## 2. Les tests doivent passer

Avant toute pull request, construire l'image et rejouer les tests en local :

```bash
make build && make test
go vet ./... && go test ./...
```

Une version ne s'ecrit que dans `versions.json`, avec son sha256 dans le meme
commit. Le Dockerfile n'a volontairement aucune valeur par defaut.
