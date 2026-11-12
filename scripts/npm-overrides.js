#!/usr/bin/env node
// Overrides npm de securite, appliques au stage `deps` (cf. SECURITY.md).
//
//   npm-overrides.js apply  <dir> <npm-overrides.json>              avant `npm install`
//   npm-overrides.js verify <dir> <npm-overrides.json>              apres
//   npm-overrides.js prune  <npm-overrides.json> <package-lock.json>
//
// Une cle vaut `nom` (toutes les copies) ou `nom@majeure` (les copies de
// cette majeure seulement : brace-expansion 1 et 2 cohabitent dans l'arbre).
//
// apply refuse un override devenu inutile -- paquet absent du lockfile, ou
// amont deja a la version epinglee ou au-dela : l'appliquer quand meme
// retrograderait. La liste ne garde ainsi que ce que l'amont n'a pas corrige.
// Quand les copies d'un meme paquet ne sont pas toutes au meme niveau (qs 6.16.2
// sous express, 6.14.3 a la racine), apply epingle la plus haute entre
// l'override et ce que l'amont fournit deja : epingler la version de
// l'override ferait redescendre les copies saines, et npm ne le fait pas.
// verify refuse un arbre ou une copie visee est SOUS la version de l'override
// (au-dessus, c'est un correctif plus recent : sain, jamais un echec).
//
// prune retire du fichier les entrees devenues inutiles au lieu de les
// signaler en erreur -- a lancer AVANT `apply`, par version-watch.yml,
// contre le lockfile de la CIBLE d'une montee automatique (une montee
// manuelle de versions.json qui oublierait de retirer l'entree casserait
// sinon `apply` au prochain build, sans rien committer de faux entre-temps :
// meme risque documente dans le SECURITY.md de traefik-hardened pour
// go-overrides.json).
"use strict";
const fs = require("fs");
const path = require("path");

const [mode, ...rest] = process.argv.slice(2);
if (mode === "prune") {
    const [ovPath, lockPath] = rest;
    if (!ovPath || !lockPath) {
        console.error("usage : npm-overrides.js prune <npm-overrides.json> <package-lock.json>");
        process.exit(2);
    }
    const overrides = JSON.parse(fs.readFileSync(ovPath, "utf8"));
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")).packages;
    const restantes = {};
    const retirees = [];
    for (const [key, entry] of Object.entries(overrides)) {
        const sel = parseKey(key);
        const locked = Object.entries(lock)
            .filter(([p, v]) => p && !v.dev && matches(sel, p.split("node_modules/").pop(), v.version))
            .map(([, v]) => v.version);
        if (locked.length && locked.every((v) => cmp(v, entry.version) >= 0)) {
            retirees.push(`${key} : l'amont fournit deja ${[...new Set(locked)].join(", ")} (>= ${entry.version})`);
            continue;
        }
        restantes[key] = entry;
    }
    if (retirees.length) {
        fs.writeFileSync(ovPath, JSON.stringify(restantes, null, 4) + "\n");
        console.log(retirees.join("\n"));
    } else {
        console.log("prune : aucun override devenu inutile.");
    }
    process.exit(0);
}

const [dir, ovPath] = rest;
if (!["apply", "verify"].includes(mode) || !dir || !ovPath) {
    console.error("usage : npm-overrides.js apply|verify <dir> <npm-overrides.json>");
    process.exit(2);
}

const overrides = JSON.parse(fs.readFileSync(ovPath, "utf8"));
const errors = [];

function parseKey(key) {
    const m = /^(@?[^@]+)(?:@(\d+))?$/.exec(key);
    if (!m) {
        throw new Error(`cle invalide : ${key}`);
    }
    return { name: m[1], major: m[2] };
}

function cmp(a, b) {
    const pa = a.split(/[.+-]/).map(Number);
    const pb = b.split(/[.+-]/).map(Number);
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) {
            return pa[i] - pb[i];
        }
    }
    return 0;
}

function matches(sel, name, version) {
    return name === sel.name && (!sel.major || version.split(".")[0] === sel.major);
}

if (mode === "apply") {
    const pkgPath = path.join(dir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const lock = JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8")).packages;
    pkg.overrides = pkg.overrides || {};

    for (const [key, { version }] of Object.entries(overrides)) {
        const sel = parseKey(key);
        const locked = Object.entries(lock)
            .filter(([p, v]) => p && !v.dev && matches(sel, p.split("node_modules/").pop(), v.version))
            .map(([, v]) => v.version);
        if (locked.length === 0) {
            errors.push(`${key} : absent du lockfile de production, override a retirer`);
            continue;
        }
        if (locked.every((v) => cmp(v, version) >= 0)) {
            errors.push(`${key} : l'amont fournit deja ${[...new Set(locked)].join(", ")} (>= ${version}), override a retirer`);
            continue;
        }
        // Jamais en dessous de ce que l'amont fournit deja sur une copie.
        const pin = locked.reduce((hi, v) => (cmp(v, hi) > 0 ? v : hi), version);
        // npm refuse un override sur une dependance directe dont la
        // declaration ne correspond pas : la declaration suit l'override.
        if (pkg.dependencies && pkg.dependencies[sel.name]) {
            pkg.dependencies[sel.name] = pin;
        }
        pkg.overrides[key] = pin;
        console.log(`${key} : ${[...new Set(locked)].join(", ")} -> ${pin}`);
    }
    if (errors.length === 0) {
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + "\n");
    }
} else {
    const installed = [];
    (function walk(nm) {
        if (!fs.existsSync(nm)) {
            return;
        }
        for (const entry of fs.readdirSync(nm)) {
            const dirs = entry.startsWith("@")
                ? fs.readdirSync(path.join(nm, entry)).map((e) => path.join(nm, entry, e))
                : [path.join(nm, entry)];
            for (const d of dirs) {
                const pj = path.join(d, "package.json");
                if (fs.existsSync(pj)) {
                    const { name, version } = JSON.parse(fs.readFileSync(pj, "utf8"));
                    installed.push({ name, version, where: d });
                }
                walk(path.join(d, "node_modules"));
            }
        }
    })(path.join(dir, "node_modules"));

    for (const [key, { version }] of Object.entries(overrides)) {
        const sel = parseKey(key);
        const copies = installed.filter((p) => matches(sel, p.name, p.version));
        if (copies.length === 0) {
            errors.push(`${key} : aucune copie installee`);
        }
        for (const c of copies.filter((c) => cmp(c.version, version) < 0)) {
            errors.push(`${key} : ${c.where} est en ${c.version}, attendu >= ${version}`);
        }
    }
    if (errors.length === 0) {
        console.log(`overrides verifies : ${Object.keys(overrides).length} entrees, ${installed.length} paquets installes`);
    }
}

if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
}
