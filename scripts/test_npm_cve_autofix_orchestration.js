// Tests de l'orchestration de scripts/npm-cve-autofix.js : regroupement du
// rapport Trivy par paquet, et lecture des derogations existantes dans
// .trivyignore (pour savoir si une fenetre vient de s'ouvrir). Aucun reseau,
// aucune ecriture de fichier ici -- seulement du texte en entree, un objet en
// sortie.
//
//   node scripts/test_npm_cve_autofix_orchestration.js
'use strict';
const assert = require('assert');
const { groupByPackage, derogationExpiryFor } = require('./npm-cve-autofix.js');

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

// Releve reel (trivy image --format json), reduit aux champs utilises.
const RAPPORT = {
  Results: [
    { Target: 'Node.js', Class: 'lang-pkgs', Type: 'node-pkg', Vulnerabilities: [
      { VulnerabilityID: 'CVE-2026-111181', Severity: 'HIGH', PkgName: 'body-parser', InstalledVersion: '1.20.8', FixedVersion: '2.4.0, 1.20.9' },
    ] },
    { Target: 'Node.js', Class: 'lang-pkgs', Type: 'node-pkg', Vulnerabilities: [
      { VulnerabilityID: 'CVE-2026-109869', Severity: 'HIGH', PkgName: 'undici', InstalledVersion: '6.28.1', FixedVersion: '6.29.1, 7.30.1, 8.12.2' },
      // meme paquet meme version, second avis en-dessous du seuil CRITICAL/HIGH
      // (releve reel du 2026-10-26 via Grype, ajoute au scan Trivy en MEDIUM) :
      { VulnerabilityID: 'GHSA-4qv8-2p9j-2685', Severity: 'MEDIUM', PkgName: 'undici', InstalledVersion: '6.28.1', FixedVersion: '6.29.1, 7.30.1, 8.12.2' },
    ] },
    // paquet Alpine (os-pkgs) : jamais le rayon de ce script -- deja pris par
    // l'apk upgrade + rebuild automatique de cve-watch (releve impossible ici
    // de toute facon, cve-watch ne voit meme pas node_modules).
    { Target: 'usr/local/bin/init', Class: 'os-pkgs', Type: 'alpine', Vulnerabilities: [
      { VulnerabilityID: 'CVE-2026-00000', Severity: 'HIGH', PkgName: 'libcrypto3', InstalledVersion: '3.5.7-r0', FixedVersion: '3.5.8-r0' },
    ] },
  ],
};

t('groupByPackage : ignore les paquets non-npm (os-pkgs)', () => {
  const g = groupByPackage(RAPPORT);
  assert.strictEqual(Object.keys(g).length, 2, 'seuls body-parser et undici sont des node-pkg');
  assert.ok(!g.libcrypto3);
});

t('groupByPackage : une seule entree par paquet, ids regroupes', () => {
  const g = groupByPackage(RAPPORT);
  assert.strictEqual(g['body-parser'].installedVersion, '1.20.8');
  assert.strictEqual(g['body-parser'].fixedVersionsCsv, '2.4.0, 1.20.9');
  assert.deepStrictEqual(g['body-parser'].ids, ['CVE-2026-111181']);
});

t('groupByPackage : les avis compagnons du meme paquet/version se regroupent', () => {
  const g = groupByPackage(RAPPORT);
  assert.strictEqual(g.undici.ids.length, 2);
  assert.ok(g.undici.ids.includes('CVE-2026-109869'));
  assert.ok(g.undici.ids.includes('GHSA-4qv8-2p9j-2685'));
});

// --- derogationExpiryFor : lire .trivyignore, jamais le modifier ----------

const TRIVYIGNORE = `# commentaire
CVE-2026-111181 exp:2026-11-06
GHSA-4qv8-2p9j-2685 exp:2026-10-30
CVE-2026-109869 exp:2026-10-30
# bloc sans rapport
CVE-9999-00000 exp:2027-01-06
`;

t('derogationExpiryFor : trouve l\'echeance d\'un identifiant present', () => {
  assert.strictEqual(derogationExpiryFor(TRIVYIGNORE, ['CVE-2026-109869']), '2026-10-30');
});

t('derogationExpiryFor : plusieurs ids du meme paquet, meme echeance -> la rend une fois', () => {
  assert.strictEqual(derogationExpiryFor(TRIVYIGNORE, ['CVE-2026-109869', 'GHSA-4qv8-2p9j-2685']), '2026-10-30');
});

t('derogationExpiryFor : aucun identifiant present -> null', () => {
  assert.strictEqual(derogationExpiryFor(TRIVYIGNORE, ['CVE-2026-999999']), null);
});

if (failures) {
  console.error(`${failures} echec(s)`);
  process.exit(1);
}
