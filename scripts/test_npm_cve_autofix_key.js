// Tests du choix de cle d'override : `pkg` seul, ou `pkg@majeure` quand
// plusieurs majeures du MEME paquet coexistent dans l'arbre (ex. undici@6 et
// undici@7 imbriques -- npm-overrides.js impose cette forme pour ne viser
// que les copies de la majeure installee, cf. son entete). La donnee vient
// du `package-lock.json` de l'amont, au tag epingle -- jamais devinee.
//
//   node scripts/test_npm_cve_autofix_key.js
'use strict';
const assert = require('assert');
const { overrideKeyFor } = require('./npm-cve-autofix.js');

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

t('une seule majeure dans l\'arbre -> cle nue', () => {
  const lock = {
    'node_modules/body-parser': { version: '1.20.8' },
    'node_modules/express/node_modules/body-parser': { version: '1.20.8' },
  };
  assert.strictEqual(overrideKeyFor('body-parser', '1.20.8', lock), 'body-parser');
});

t('deux majeures dans l\'arbre -> cle suffixee par la majeure installee', () => {
  const lock = {
    'node_modules/undici': { version: '6.28.1' },
    'node_modules/cheerio/node_modules/undici': { version: '5.28.4' },
  };
  assert.strictEqual(overrideKeyFor('undici', '6.28.1', lock), 'undici@6');
});

t('les paquets dev sont ignores (jamais vises par un override de prod)', () => {
  const lock = {
    'node_modules/foo': { version: '1.0.0' },
    'node_modules/bar/node_modules/foo': { version: '2.0.0', dev: true },
  };
  assert.strictEqual(overrideKeyFor('foo', '1.0.0', lock), 'foo', 'la copie dev ne compte pas comme une 2e majeure');
});

if (failures) {
  console.error(`${failures} echec(s)`);
  process.exit(1);
}
