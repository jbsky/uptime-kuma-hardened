// Tests de la decision pure de scripts/npm-cve-autofix.js (fonction `decide`).
//
// Le scan de Trivy sur l'image finale voit les CVE npm (cve-watch ne les voit
// jamais : sa SBOM est celle du stage `prep`, sans node_modules -- mesure le
// 2026-10-26, 0 composant npm sur 37). `decide` prend un releve DEJA groupe
// par paquet (une CVE peut avoir plusieurs candidats de correctif, une
// `FixedVersion` Trivy en liste plusieurs separes par virgule) et dit s'il
// faut poser un override (npm-overrides.json), une derogation a echeance
// (.trivyignore / .grype.yaml), ou rien (nouvelle majeure, hors overrides).
//
//   node scripts/test_npm_cve_autofix.js
'use strict';
const assert = require('assert');
const { decide, pickFix, cmp, applyOverride, parseMinReleaseAge, jetonSur } = require('./npm-cve-autofix.js');

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

// --- pickFix : meme majeure que l'installe, le plus bas qui corrige -------

t('pickFix : un seul candidat, meme majeure', () => {
  assert.strictEqual(pickFix('1.20.8', '1.20.9'), '1.20.9');
});

t('pickFix : plusieurs candidats, garde la majeure installee', () => {
  // undici 6.28.1 -- Trivy liste 6.29.1, 7.30.1, 8.12.2 (releve reel, CVE-2026-109869)
  assert.strictEqual(pickFix('6.28.1', '6.29.1, 7.30.1, 8.12.2'), '6.29.1');
});

t('pickFix : aucune majeure installee dans la liste -> null', () => {
  // tar 6.2.1 -- correctif en 7.x seulement (releve reel)
  assert.strictEqual(pickFix('6.2.1', '7.0.0'), null);
});

t('pickFix : plusieurs candidats de la bonne majeure -> le plus bas', () => {
  assert.strictEqual(pickFix('1.0.0', '1.0.5, 1.0.2'), '1.0.2');
});

// --- decide -----------------------------------------------------------------

const BASE = {
  pkg: 'body-parser', installedVersion: '1.20.8', fixedVersionsCsv: '2.4.0, 1.20.9',
  overrideVersion: null, derogationExpiry: null, publishDate: '2026-10-22', minReleaseAgeDays: 14,
};

t('nouvelle majeure seule -> skip (hors overrides, conseil humain)', () => {
  const d = decide({ ...BASE, fixedVersionsCsv: '2.4.0', today: '2026-10-26' });
  assert.strictEqual(d.action, 'skip');
});

t('correctif meme majeure, trop recent -> derogation a echeance', () => {
  // publie le 2026-10-22, min-release-age=14 -> fenetre ouverte le 2026-11-05
  const d = decide({ ...BASE, today: '2026-10-26' });
  assert.strictEqual(d.action, 'derogate');
  assert.strictEqual(d.version, '1.20.9');
  assert.strictEqual(d.expiry, '2026-11-06', 'echeance = ouverture de la fenetre + 1 j de marge');
});

t('correctif meme majeure, fenetre ouverte, aucun override -> override', () => {
  const d = decide({ ...BASE, today: '2026-11-06' });
  assert.strictEqual(d.action, 'override');
  assert.strictEqual(d.version, '1.20.9');
  assert.strictEqual(d.dropDerogation, false, 'rien a retirer, il n\'y avait pas de derogation');
});

t('derogation existante, fenetre maintenant ouverte -> override, derogation a retirer', () => {
  const d = decide({ ...BASE, derogationExpiry: '2026-11-06', today: '2026-11-06' });
  assert.strictEqual(d.action, 'override');
  assert.strictEqual(d.dropDerogation, true);
});

t('derogation existante, fenetre toujours fermee -> rien de nouveau', () => {
  const d = decide({ ...BASE, derogationExpiry: '2026-11-06', today: '2026-10-27' });
  assert.strictEqual(d.action, 'none', 'la derogation deja posee couvre deja ce jour');
});

t('override deja a la bonne version -> none (idempotent)', () => {
  const d = decide({ ...BASE, overrideVersion: '1.20.9', today: '2026-11-06' });
  assert.strictEqual(d.action, 'none');
});

t('override deja a une version plus haute -> none (jamais retrograder)', () => {
  const d = decide({ ...BASE, overrideVersion: '1.20.20', today: '2026-11-06' });
  assert.strictEqual(d.action, 'none');
});

t('date de publication inconnue -> skip, jamais de devinette', () => {
  const d = decide({ ...BASE, publishDate: null, today: '2026-10-26' });
  assert.strictEqual(d.action, 'skip');
});

// --- cmp (ordre semver simplifie, memes regles que npm-overrides.js) -------

t('cmp : ordre simple', () => {
  assert.ok(cmp('1.20.9', '1.20.8') > 0);
  assert.ok(cmp('1.20.8', '1.20.9') < 0);
  assert.strictEqual(cmp('1.20.8', '1.20.8'), 0);
});

// --- applyOverride : ecriture du npm-overrides.json, triee, sans doublon --

t('applyOverride : nouvelle entree, insertion triee', () => {
  const ov = { axios: { version: '0.34.0', fixes: ['x'] }, ws: { version: '8.0.0', fixes: ['y'] } };
  const r = applyOverride(ov, 'body-parser', '1.20.9', ['CVE-2026-111181']);
  assert.deepStrictEqual(Object.keys(r), ['axios', 'body-parser', 'ws'], 'ordre alphabetique conserve');
  assert.deepStrictEqual(r['body-parser'], { version: '1.20.9', fixes: ['CVE-2026-111181'] });
});

t('applyOverride : entree existante -> version et fixes remplaces', () => {
  const ov = { 'undici@6': { version: '6.28.1', fixes: ['GHSA-rfgv-xxqx-mfg5'] } };
  const r = applyOverride(ov, 'undici@6', '6.29.1', ['CVE-2026-109869', 'GHSA-4qv8-2p9j-2685']);
  assert.strictEqual(r['undici@6'].version, '6.29.1');
  assert.deepStrictEqual(r['undici@6'].fixes, ['CVE-2026-109869', 'GHSA-4qv8-2p9j-2685']);
});

t('applyOverride : n\'altere pas l\'objet recu (pas d\'effet de bord)', () => {
  const ov = { axios: { version: '0.34.0', fixes: [] } };
  applyOverride(ov, 'body-parser', '1.20.9', ['x']);
  assert.deepStrictEqual(Object.keys(ov), ['axios']);
});

// --- parseMinReleaseAge : lecture du .npmrc de l'amont, jamais suppose ----

t('parseMinReleaseAge : valeur presente', () => {
  assert.strictEqual(parseMinReleaseAge('legacy-peer-deps=true\nmin-release-age=14\n'), 14);
});

t('parseMinReleaseAge : absente -> null, jamais 0 par defaut', () => {
  assert.strictEqual(parseMinReleaseAge('legacy-peer-deps=true\n'), null);
});

// --- jetonSur : refuse tout ce qui ressemble a une injection shell --------

t('jetonSur : accepte un CVE, un GHSA, un paquet scope, un semver', () => {
  assert.strictEqual(jetonSur('CVE-2026-111181'), 'CVE-2026-111181');
  assert.strictEqual(jetonSur('@azure/msal-node'), '@azure/msal-node');
  assert.strictEqual(jetonSur('6.29.1'), '6.29.1');
});

t('jetonSur : refuse un metacaractere shell', () => {
  for (const s of ['foo; rm -rf /', 'foo`id`', 'foo$(id)', 'foo"bar', "foo'bar", 'foo bar']) {
    assert.throws(() => jetonSur(s), new RegExp('refuse'), `aurait du refuser ${JSON.stringify(s)}`);
  }
});

if (failures) {
  console.error(`${failures} echec(s)`);
  process.exit(1);
}
