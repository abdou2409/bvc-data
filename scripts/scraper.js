/**
 * scraper.js — Pipeline de mise à jour automatique des cours BVC
 * ─────────────────────────────────────────────────────────────
 * Exécuté par GitHub Actions (voir .github/workflows/update-bvc.yml),
 * PAS dans le navigateur → aucun blocage CORS, aucun proxy tiers requis.
 *
 * Réutilise volontairement la même logique d'extraction que les fonctions
 * fetchIDBourse() / fetchCasaBourse() déjà présentes et éprouvées dans
 * bvc-portfolio-manager-corrige.html, simplement portée en Node.js.
 *
 * IMPORTANT — honnêteté technique :
 * idbourse.com et casablancabourse.com n'ont pas d'API publique documentée.
 * Ce script fait du scraping HTML, ce qui est par nature fragile : si la
 * structure de ces sites change, le script peut cesser de trouver des
 * données. C'est pour cela qu'il :
 *   1) log précisément ce qu'il a trouvé/pas trouvé (voir Actions > logs)
 *   2) n'écrase JAMAIS data/bvc-data.json avec un résultat vide —
 *      en cas d'échec total, l'ancien fichier (dernière donnée valide) reste en place
 *   3) ne fabrique aucune valeur : un titre non trouvé n'apparaît simplement
 *      pas dans le JSON (l'app garde alors son dernier cours connu)
 */

const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'bvc-data.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
  return res.text();
}

// ── Source 1 : idbourse.com (page globale /masi, format Next.js) ──────────
async function fetchFromIDBourse() {
  const url = 'https://www.idbourse.com/masi';
  try {
    const html = await fetchText(url);
    if (!html || html.length < 1000) return { quotes: [], note: 'idbourse.com: réponse trop courte' };

    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
    if (nextDataMatch) {
      try {
        const nextData = JSON.parse(nextDataMatch[1]);
        const props = nextData?.props?.pageProps;
        const actions = props?.actions || props?.quotes || props?.stocks || props?.data || props?.masi;
        if (Array.isArray(actions) && actions.length > 0) {
          const quotes = actions
            .map(a => ({
              ticker: (a.ticker || a.symbol || a.code || a.symbole || '').toUpperCase(),
              price: parseFloat(a.price || a.cours || a.last || a.close || 0),
            }))
            .filter(q => q.ticker && q.price > 0);
          return { quotes, note: `idbourse.com __NEXT_DATA__: ${quotes.length} titres` };
        }
      } catch (e) {
        return { quotes: [], note: `idbourse.com __NEXT_DATA__ présent mais JSON invalide: ${e.message}` };
      }
    }
    return { quotes: [], note: 'idbourse.com: aucune structure __NEXT_DATA__/actions reconnue (site probablement modifié)' };
  } catch (e) {
    return { quotes: [], note: `idbourse.com: échec fetch — ${e.message}` };
  }
}

// ── Source 2 : casablancabourse.com (repli, table HTML live-market) ───────
async function fetchFromCasablancaBourse() {
  const url = 'https://www.casablanca-bourse.com/fr/live-market/transactions-actions';
  try {
    const html = await fetchText(url);
    if (!html || html.length < 1000) return { quotes: [], note: 'casablanca-bourse.com: réponse trop courte' };

    // Extraction par table HTML brute (regex simple, pas de DOM parser en Node natif)
    const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];
    const quotes = [];
    for (const row of rows) {
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c =>
        c[1].replace(/<[^>]+>/g, '').trim()
      );
      if (cells.length < 2) continue;
      const tickerMatch = cells[0].match(/\b([A-Z]{2,5})\b/);
      const priceMatch = (cells[1] || '').replace(/\s/g, '').replace(',', '.').match(/[\d.]+/);
      if (tickerMatch && priceMatch) {
        const price = parseFloat(priceMatch[0]);
        if (price > 0.5 && price < 500000) {
          quotes.push({ ticker: tickerMatch[1], price });
        }
      }
    }
    return { quotes, note: `casablanca-bourse.com: ${quotes.length} lignes candidates extraites` };
  } catch (e) {
    return { quotes: [], note: `casablanca-bourse.com: échec fetch — ${e.message}` };
  }
}

async function main() {
  const log = [];
  let quotes = [];

  const r1 = await fetchFromIDBourse();
  log.push(r1.note);
  if (r1.quotes.length >= 10) quotes = r1.quotes;

  if (quotes.length < 10) {
    const r2 = await fetchFromCasablancaBourse();
    log.push(r2.note);
    if (r2.quotes.length > quotes.length) quotes = r2.quotes;
  }

  console.log('── Log d\'exécution ──');
  log.forEach(l => console.log(' -', l));
  console.log(`Total titres trouvés : ${quotes.length}`);

  if (quotes.length < 10) {
    console.error(
      `⚠️ Moins de 10 titres trouvés (${quotes.length}). ` +
      `Fichier data/bvc-data.json NON modifié pour éviter d'écraser la dernière donnée valide par un résultat quasi-vide. ` +
      `Vérifier si idbourse.com / casablanca-bourse.com ont changé de structure.`
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
