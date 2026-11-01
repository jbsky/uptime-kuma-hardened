// Tests de l'ecart vs la derniere version npm disponible, affiche dans le
// corps du commit d'un override. `pickFix` ne retient jamais une majeure
// au-dela de celle installee (cf. npm-overrides.js) : le correctif pose
// peut donc rester loin de `dist-tags.latest` (undici 6.29.1 pendant que
// 8.12.2 existe deja). Signale seulement quand il y a un vrai ecart de
// MAJEURE -- jamais de bruit quand le correctif rejoint deja la derniere
// version connue.
//
//   node scripts/test_npm_cve_autofix_gap.js
'use strict';
const assert = require('assert');
const { latestVersion, renderOverrideLine } = require('./npm-cve-autofix.js');

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

// --- latestVersion : lecture pure de dist-tags.latest ----------------------

t('latestVersion : lit dist-tags.latest du document du registre', () => {
  assert.strictEqual(latestVersion({ 'dist-tags': { latest: '8.12.2' } }), '8.12.2');
});

t('latestVersion : absent -> null, jamais une devinette', () => {
  assert.strictEqual(latestVersion({}), null);
  assert.strictEqual(latestVersion({ 'dist-tags': {} }), null);
});

// --- renderOverrideLine : la ligne du corps de commit -----------------------

t('renderOverrideLine : latest de la MEME majeure que le correctif -> ligne inchangee', () => {
  const l = renderOverrideLine({ key: 'body-parser', installed: '1.20.8', fix: '1.20.9', latest: '1.21.3' });
  assert.strictEqual(l, 'body-parser : 1.20.8 -> 1.20.9');
});

t('renderOverrideLine : latest d\'une majeure PLUS RECENTE -> ecart signale', () => {
  // undici 6.28.1 -> 6.29.1 (correctif, meme majeure) alors que 8.12.2 existe deja.
  const l = renderOverrideLine({ key: 'undici', installed: '6.28.1', fix: '6.29.1', latest: '8.12.2' });
  assert.strictEqual(l, 'undici : 6.28.1 -> 6.29.1 (latest npm en 8.x : 8.12.2)');
});

t('renderOverrideLine : latest inconnu (metadata indisponible) -> ligne inchangee, jamais d\'echec', () => {
  const l = renderOverrideLine({ key: 'body-parser', installed: '1.20.8', fix: '1.20.9', latest: null });
  assert.strictEqual(l, 'body-parser : 1.20.8 -> 1.20.9');
});

t('renderOverrideLine : latest EXACTEMENT la version du correctif -> ligne inchangee', () => {
  const l = renderOverrideLine({ key: 'body-parser', installed: '1.20.8', fix: '1.20.9', latest: '1.20.9' });
  assert.strictEqual(l, 'body-parser : 1.20.8 -> 1.20.9');
});

if (failures) {
  console.error(`${failures} echec(s)`);
  process.exit(1);
}
