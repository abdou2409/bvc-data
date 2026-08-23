/**
 * scraper.js — Pipeline de mise à jour automatique des cours BVC
 * ─────────────────────────────────────────────────────────────
 * Exécuté par GitHub Actions (voir .github/workflows/update-bvc.yml),
 * PAS dans le navigateur → aucun blocage CORS, aucun proxy tiers requis.
 *
 * Source retenue : casabourse.ma (page d'accueil).
 * ─────────────────────────────────────────────────────────────
 * Historique de la décision (honnêteté technique, pour qui relira ce fichier) :
 *  - idbourse.com/masi a été testé en premier : ce site charge désormais ses
 *    cotations par JavaScript après le chargement de la page. Le HTML brut
 *    ne contient donc aucune donnée exploitable par un simple fetch — abandonné.
 *  - casablanca-bourse.com (site OFFICIEL de la Bourse) a été testé ensuite :
 *    son robots.txt interdit explicitement l'accès automatisé. On respecte
 *    cette règle — abandonné, ne pas réessayer de le contourner.
 *  - casabourse.ma (plateforme tierce, pas le site officiel) affiche les cours
 *    de ~78 valeurs directement dans le HTML de sa page d'accueil (rendu
 *    côté serveur WordPress), sans blocage robots.txt constaté. C'est la
 *    source retenue ici.
 *
 * IMPORTANT — limites qui restent :
 *  - Pas d'API officielle : ceci reste du scraping HTML, donc fragile par
 *    nature si casabourse.ma change la structure de sa page d'accueil.
 *  - Ce script ne fabrique aucune valeur : un titre non trouvé n'apparaît
 *    simplement pas dans le JSON (l'app garde alors son dernier cours connu).
 *  - En cas d'échec total, l'ancien data/bvc-data.json n'est JAMAIS écrasé
 *    par un résultat vide (voir la vérification "< 10 titres" plus bas).
 */

const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'bvc-data.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
  return res.text();
}

// Convertit "1 801" / "1\u00A0801,50" / "37,48" → nombre JS
function parseFrenchNumber(str) {
  if (!str) return NaN;
  const cleaned = str.replace(/[\s\u00A0]/g, '').replace(',', '.');
  return parseFloat(cleaned);
}

// ── Source : casabourse.ma (bandeau de cotations en page d'accueil) ───────
async function fetchFromCasabourseMa() {
  const url = 'https://casabourse.ma/';
  try {
    const html = await fetchText(url);
    if (!html || html.length < 5000) {
      return { quotes: [], note: 'casabourse.ma: réponse trop courte' };
    }

    // Chaque valeur est un lien vers /entreprise/<slug>/ contenant le ticker,
    // le prix en MAD et la variation. On isole le contenu de chaque lien,
    // on retire les balises internes (logo <img>), puis on lit le texte.
    const anchorRe = /<a\s+href="https:\/\/casabourse\.ma\/entreprise\/[a-z0-9-]+\/"[^>]*>([\s\S]*?)<\/a>/g;
    const lineRe = /([A-Z0-9]{2,6})\s+([\d\s\u00A0]+(?:[.,]\d+)?)\s*MAD/;

    const quotes = [];
    const seen = new Set();
    let m;
    while ((m = anchorRe.exec(html)) !== null) {
      const innerText = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const lm = innerText.match(lineRe);
      if (!lm) continue;
      const ticker = lm[1];
      const price = parseFrenchNumber(lm[2]);
      if (!ticker || !(price > 0) || seen.has(ticker)) continue;
      seen.add(ticker);
      quotes.push({ ticker, price });
    }

    return { quotes, note: `casabourse.ma: ${quotes.length} valeurs extraites` };
  } catch (e) {
    return { quotes: [], note: `casabourse.ma: échec fetch — ${e.message}` };
  }
}

async function main() {
  const log = [];
  let quotes = [];

  const r1 = await fetchFromCasabourseMa();
  log.push(r1.note);
  if (r1.quotes.length > quotes.length) quotes = r1.quotes;

  console.log('── Log d\'exécution ──');
  log.forEach(l => console.log(' -', l));
  console.log(`Total titres trouvés : ${quotes.length}`);

  if (quotes.length < 10) {
    console.error(
      `⚠️ Moins de 10 titres trouvés (${quotes.length}). ` +
      `Fichier data/bvc-data.json NON modifié pour éviter d'écraser la dernière donnée valide par un résultat quasi-vide. ` +
      `Vérifier si casabourse.ma a changé la structure de sa page d'accueil.`
    );
    process.exitCode = 1; // fait échouer le job Actions -> visible dans l'historique
    return;
  }

  const payload = {
    generated_at: new Date().toISOString(),
    source_log: log,
    quotes,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`✓ Écrit ${OUTPUT_PATH} (${quotes.length} titres)`);
}

main().catch(e => {
  console.error('Erreur fatale du scraper:', e);
  process.exitCode = 1;
});

