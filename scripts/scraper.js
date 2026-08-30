/**
 * scraper.js — Pipeline de mise à jour automatique des cours BVC
 * ─────────────────────────────────────────────────────────────
 * Exécuté par GitHub Actions (voir .github/workflows/update-bvc.yml),
 * PAS dans le navigateur → aucun blocage CORS, aucun proxy tiers requis.
 *
 * Cascade de sources, dans cet ordre :
 *   1) Saisie manuelle (input manual_data du workflow) — prioritaire si fournie,
 *      100% fiable car indépendante de tout site externe.
 *   2) TradingView (API scanner publique, préfixe CSEMA:) — non testable
 *      directement avant livraison (voir avertissement dans la fonction).
 *   3) casabourse.ma (scraping HTML de la page d'accueil) — vérifié
 *      fonctionnel au moment de l'écriture, mais reste fragile par nature.
 * ─────────────────────────────────────────────────────────────
 * Historique de la décision (honnêteté technique, pour qui relira ce fichier) :
 *  - idbourse.com/masi : ce site charge ses cotations par JavaScript après
 *    le chargement de la page. Rien d'exploitable dans le HTML brut — abandonné.
 *  - casablanca-bourse.com (site OFFICIEL de la Bourse) : robots.txt interdit
 *    explicitement l'accès automatisé. On respecte cette règle — abandonné.
 *  - marocboursier.com : cours affichés via un widget TradingView en
 *    JavaScript (iframe), même problème qu'idbourse.com — abandonné.
 *
 * IMPORTANT — limites qui restent :
 *  - Aucune de ces sources n'est une API officielle garantie dans le temps.
 *    Si elles changent leur structure, il faudra ajuster le script.
 *  - Ce script ne fabrique aucune valeur : un titre non trouvé n'apparaît
 *    simplement pas dans le JSON (l'app garde alors son dernier cours connu).
 *  - En cas d'échec total, l'ancien data/bvc-data.json n'est JAMAIS écrasé
 *    par un résultat vide (voir la vérification "< 5 titres" plus bas).
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

// ── Source manuelle (prioritaire, 100% fiable) ─────────────────────────────
// Format attendu : une ligne par titre "TICKER PRIX" (ex: "ATW 705.5").
// Aucune dépendance à un site externe → ne peut jamais "casser".
function parseManualData(raw) {
  if (!raw || !raw.trim()) return { quotes: [], note: 'Aucune saisie manuelle fournie' };
  const quotes = [];
  const seen = new Set();
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const m = line.trim().match(/^([A-Z0-9]{2,6})\s+([\d]+(?:[.,]\d+)?)$/i);
    if (!m) continue;
    const ticker = m[1].toUpperCase();
    const price = parseFloat(m[2].replace(',', '.'));
    if (!(price > 0) || seen.has(ticker)) continue;
    seen.add(ticker);
    quotes.push({ ticker, price });
  }
  return { quotes, note: `Saisie manuelle: ${quotes.length} titres sur ${lines.filter(l=>l.trim()).length} lignes fournies` };
}

// Liste des ~78 tickers cotés à la Bourse de Casablanca (repris de l'app).
// Utilisée pour interroger TradingView explicitement titre par titre.
const BVC_TICKERS = ['ADH','ADI','AFI','AFM','AGM','AKT','ALM','ARD','ATH','ATL','ATW','BAL','BCI','BCP','BOA','CAP','CDM','CFG','CIH','CMA','CMG','CMT','COL','CRS','CSR','CTM','DHO','DIS','DLM','DRI','DWY','DYT','EQD','FBR','GAZ','GTM','HPS','IAM','IBC','IMO','INV','JET','LBV','LES','LHM','M2M','MAB','MDP','MIC','MLE','MNG','MOX','MSA','MUT','NEJ','NKL','OUL','PRO','RDS','REB','RIS','S2M','SAH','SAM','SBM','SID','SLF','SMI','SNA','SNP','SOT','SRM','STR','T2S','TGC','TMA','TQM','UMR','VCN','WAA','ZDJ'];

// ── Source : TradingView (API "scanner" publique, utilisée par leurs
// propres widgets de grille de cours, sans clé ni authentification).
// Bourse de Casablanca disponible sous le préfixe "CSEMA:" depuis 2024.
// ─────────────────────────────────────────────────────────────────────
// AVERTISSEMENT HONNÊTE : cette méthode est documentée et utilisée par
// plusieurs projets open source indépendants depuis des années, ce qui la
// rend plus stable qu'un scraping HTML classique — MAIS elle n'a pas pu
// être testée directement avant livraison (accès réseau restreint côté
// outil de développement). Le diagnostic ci-dessous log tout ce qui est
// reçu pour corriger vite si le premier essai échoue.
async function fetchFromTradingView() {
  const tickers = BVC_TICKERS.map(t => `CSEMA:${t}`);
  // Plusieurs "shards" possibles selon la région TradingView — on essaie
  // dans l'ordre et on garde le premier qui répond avec des données.
  const shards = ['africa', 'america', 'global'];

  for (const shard of shards) {
    const url = `https://scanner.tradingview.com/${shard}/scan`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbols: { tickers, query: { types: [] } },
          columns: ['close'],
        }),
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      console.log(`   [diag TradingView/${shard}] HTTP ${res.status} · ${text.length} caractères reçus`);
      console.log(`   [diag TradingView/${shard}] Premiers 300 caractères : ${text.slice(0, 300).replace(/\s+/g, ' ')}`);

      if (!res.ok) continue;
      let json;
      try { json = JSON.parse(text); } catch { continue; }
      const rows = json?.data;
      if (!Array.isArray(rows) || rows.length === 0) continue;

      const quotes = [];
      for (const row of rows) {
        const sym = (row.s || '').split(':')[1];
        const price = row.d?.[0];
        if (sym && typeof price === 'number' && price > 0) quotes.push({ ticker: sym, price });
      }
      if (quotes.length >= 5) {
        return { quotes, note: `TradingView (shard ${shard}): ${quotes.length} valeurs extraites` };
      }
    } catch (e) {
      console.log(`   [diag TradingView/${shard}] échec: ${e.message}`);
    }
  }
  return { quotes: [], note: 'TradingView: aucun shard n\'a renvoyé de données exploitables (voir diagnostics ci-dessus)' };
}

// ── Source : casabourse.ma (bandeau de cotations en page d'accueil) ───────
async function fetchFromCasabourseMa() {
  const url = 'https://casabourse.ma/';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(20000),
    });
    const html = await res.text();

    // Diagnostic systématique : toujours logué, même en cas de succès, pour
    // savoir immédiatement si le contenu reçu diffère de ce qui est attendu.
    const occurrences = (html.match(/casabourse\.ma\/entreprise\//gi) || []).length;
    console.log(`   [diag] HTTP ${res.status} · ${html.length} caractères reçus · ${occurrences} occurrences de "entreprise/" trouvées`);
    console.log(`   [diag] Premiers 400 caractères du <body> : ${(html.match(/<body[^>]*>([\s\S]{0,400})/i)?.[1] || html.slice(0,400)).replace(/\s+/g,' ')}`);

    if (!res.ok) return { quotes: [], note: `casabourse.ma: HTTP ${res.status}` };
    if (!html || html.length < 5000) {
      return { quotes: [], note: `casabourse.ma: réponse trop courte (${html.length} caractères)` };
    }

    // Regex volontairement tolérante : schéma optionnel, www optionnel,
    // slash final optionnel, guillemets simples ou doubles.
    const anchorRe = /<a\s+[^>]*href=["'][^"']*casabourse\.ma\/entreprise\/[a-z0-9-]+\/?["'][^>]*>([\s\S]*?)<\/a>/gi;
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

    return { quotes, note: `casabourse.ma: ${quotes.length} valeurs extraites (sur ${occurrences} liens entreprise/ détectés)` };
  } catch (e) {
    return { quotes: [], note: `casabourse.ma: échec fetch — ${e.message}` };
  }
}

async function main() {
  const log = [];
  let quotes = [];
  let sourceUsed = '';

  // Priorité absolue à la saisie manuelle si elle est fournie via
  // workflow_dispatch (voir .github/workflows/update-bvc.yml, input manual_data)
  const manual = parseManualData(process.env.MANUAL_DATA || '');
  log.push(manual.note);
  if (manual.quotes.length >= 5) {
    quotes = manual.quotes;
    sourceUsed = 'Saisie manuelle';
  }

  if (quotes.length < 5) {
    const r0 = await fetchFromTradingView();
    log.push(r0.note);
    if (r0.quotes.length > quotes.length) { quotes = r0.quotes; sourceUsed = 'TradingView (auto)'; }
  }

  if (quotes.length < 5) {
    const r1 = await fetchFromCasabourseMa();
    log.push(r1.note);
    if (r1.quotes.length > quotes.length) { quotes = r1.quotes; sourceUsed = 'casabourse.ma (auto)'; }
  }

  console.log('── Log d\'exécution ──');
  log.forEach(l => console.log(' -', l));
  console.log(`Total titres trouvés : ${quotes.length}`);

  if (quotes.length < 5) {
    console.error(
      `⚠️ Moins de 5 titres trouvés (${quotes.length}). ` +
      `Fichier data/bvc-data.json NON modifié pour éviter d'écraser la dernière donnée valide par un résultat quasi-vide. ` +
      `Utilise la saisie manuelle (manual_data) si le scraping automatique ne trouve rien, ou vérifie si casabourse.ma a changé de structure.`
    );
    process.exitCode = 1; // fait échouer le job Actions -> visible dans l'historique
    return;
  }

  const payload = {
    generated_at: new Date().toISOString(),
    source_used: sourceUsed,
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

