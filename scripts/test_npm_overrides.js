// Tests de npm-overrides.js (apply / verify / prune) sur de vrais fichiers,
// en sous-processus : c'est le contrat CLI que le Dockerfile et
// version-watch.yml appellent, pas des fonctions internes.
//
// Cas fondateur : version-watch du 2026-11-12 (cible 2.5.11). `qs` y existe
// en 6.16.2 (sous body-parser et express, deja corrige) ET en 6.14.3 (a la
// racine, encore vulnerable ; correctif 6.16.1). L'ancien `apply` epinglait
// 6.16.1 : npm gardait 6.16.2 sur les copies deja saines et `verify`
// exigeait l'egalite -> build rouge, aucune montee publiee.
//
//   node scripts/test_npm_overrides.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'npm-overrides.js');
let failures = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// Projet factice : lockfile (clef `packages`), package.json, et node_modules
// optionnel (pour verify) decrit par { 'chemin/relatif': 'version' }.
function projet({ lock, deps = {}, installed = {}, overrides }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ukh-ov-'));
  const packages = { '': { name: 'x', version: '1.0.0' } };
  for (const [p, version] of Object.entries(lock)) packages[p] = { version };
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ packages }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: deps }));
  for (const [rel, version] of Object.entries(installed)) {
    const d = path.join(dir, rel);
    fs.mkdirSync(d, { recursive: true });
    const name = rel.split('node_modules/').pop();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name, version }));
  }
  const ov = path.join(dir, 'npm-overrides.json');
  fs.writeFileSync(ov, JSON.stringify(overrides));
  return { dir, ov, pkg: () => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) };
}

const QS_MIXTE = {
  'node_modules/qs': '6.14.3',
  'node_modules/body-parser/node_modules/qs': '6.16.2',
  'node_modules/express/node_modules/qs': '6.16.2',
};
const QS_OV = { qs: { version: '6.16.1', fixes: ['CVE-2026-110816'] } };

t('apply : lockfile mixte (6.14.3 + 6.16.2) -> ne retrograde pas, epingle >= 6.16.2', () => {
  const p = projet({ lock: QS_MIXTE, overrides: QS_OV });
  const r = run(['apply', p.dir, p.ov]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(p.pkg().overrides.qs, '6.16.2');
});

t('apply : toutes les copies deja saines -> refus (override a retirer)', () => {
  const p = projet({
    lock: { 'node_modules/qs': '6.16.2', 'node_modules/x/node_modules/qs': '6.16.2' },
    overrides: QS_OV,
  });
  const r = run(['apply', p.dir, p.ov]);
  assert.strictEqual(r.code, 1);
  assert.ok(/override a retirer/.test(r.err), r.err);
});

t('apply : copie unique vulnerable -> epingle la version de l\'override', () => {
  const p = projet({ lock: { 'node_modules/qs': '6.14.2' }, overrides: QS_OV });
  const r = run(['apply', p.dir, p.ov]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(p.pkg().overrides.qs, '6.16.1');
});

t('apply : dependance directe -> la declaration suit l\'epinglage effectif', () => {
  const p = projet({ lock: QS_MIXTE, deps: { qs: '6.14.3' }, overrides: QS_OV });
  const r = run(['apply', p.dir, p.ov]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(p.pkg().dependencies.qs, '6.16.2');
  assert.strictEqual(p.pkg().overrides.qs, '6.16.2');
});

t('verify : arbre mixte apres install (6.16.2 partout) -> accepte', () => {
  const p = projet({
    lock: QS_MIXTE,
    installed: {
      'node_modules/qs': '6.16.2',
      'node_modules/body-parser/node_modules/qs': '6.16.2',
      'node_modules/express/node_modules/qs': '6.16.2',
    },
    overrides: QS_OV,
  });
  const r = run(['verify', p.dir, p.ov]);
  assert.strictEqual(r.code, 0, r.err);
});

t('verify : exactement la version epinglee -> accepte', () => {
  const p = projet({ lock: {}, installed: { 'node_modules/qs': '6.16.1' }, overrides: QS_OV });
  assert.strictEqual(run(['verify', p.dir, p.ov]).code, 0);
});

t('verify : une copie sous la version epinglee -> refus (le garde reste)', () => {
  const p = projet({
    lock: {},
    installed: {
      'node_modules/qs': '6.14.3',
      'node_modules/body-parser/node_modules/qs': '6.16.2',
    },
    overrides: QS_OV,
  });
  const r = run(['verify', p.dir, p.ov]);
  assert.strictEqual(r.code, 1);
  assert.ok(/6\.14\.3/.test(r.err), r.err);
});

t('verify : aucune copie installee -> refus', () => {
  const p = projet({ lock: {}, installed: {}, overrides: QS_OV });
  assert.strictEqual(run(['verify', p.dir, p.ov]).code, 1);
});

t('prune : lockfile mixte -> garde l\'entree (une copie reste vulnerable)', () => {
  const p = projet({ lock: QS_MIXTE, overrides: QS_OV });
  const r = run(['prune', p.ov, path.join(p.dir, 'package-lock.json')]);
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(p.ov, 'utf8'))), ['qs']);
});

if (failures) {
  console.log(`\n${failures} echec(s)`);
  process.exit(1);
}
