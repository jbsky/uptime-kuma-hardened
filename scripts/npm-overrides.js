#!/usr/bin/env node
// Overrides npm de securite, appliques au stage `deps` (cf. SECURITY.md).
//
//   npm-overrides.js apply  <dir> <npm-overrides.json>   avant `npm install`
//   npm-overrides.js verify <dir> <npm-overrides.json>   apres
//
// Une cle vaut `nom` (toutes les copies) ou `nom@majeure` (les copies de
// cette majeure seulement : brace-expansion 1 et 2 cohabitent dans l'arbre).
//
// apply refuse un override devenu inutile -- paquet absent du lockfile, ou
// amont deja a la version epinglee ou au-dela : l'appliquer quand meme
// retrograderait. La liste ne garde ainsi que ce que l'amont n'a pas corrige.
// verify refuse un arbre ou une copie visee n'est pas a la version epinglee.
"use strict";
const fs = require("fs");
const path = require("path");

const [mode, dir, ovPath] = process.argv.slice(2);
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
        // npm refuse un override sur une dependance directe dont la
        // declaration ne correspond pas : la declaration suit l'override.
        if (pkg.dependencies && pkg.dependencies[sel.name]) {
            pkg.dependencies[sel.name] = version;
        }
        pkg.overrides[key] = version;
        console.log(`${key} : ${[...new Set(locked)].join(", ")} -> ${version}`);
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
        for (const c of copies.filter((c) => c.version !== version)) {
            errors.push(`${key} : ${c.where} est en ${c.version}, attendu ${version}`);
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
