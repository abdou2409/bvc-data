/**
 * scraper.js — Pipeline de mise à jour automatique des cours BVC
 * ─────────────────────────────────────────────────────────────
 * Exécuté par GitHub Actions (voir .github/workflows/update-bvc.yml),
 * PAS dans le navigateur → aucun blocage CORS, aucun proxy tiers requis.
 *
 * Cascade de sources, dans cet ordre :
 *   1) Saisie manuelle (input manual_data du workflow) — prioritaire si fournie,
 *      100% fiable car indépendante de tout site externe.
 *   2) TradingView (API scanner publique, préfixe CSEMA:) — CONFIRMÉ
 *      fonctionnel en conditions réelles le 30/08/2026 (shard "global").
 *   3) casabourse.ma (scraping HTML de la page d'accueil) — repli.
 *
 * DEUX FICHIERS DE SORTIE :
 *   - data/bvc-data.json : snapshot du jour (comme avant)
 *   - data/history.json  : accumulation d'un point réel par jour de bourse,
 *     construite progressivement à partir d'aujourd'hui. C'est cette
 *     accumulation qui rend les indicateurs techniques de l'app (RSI, MACD,
 *     moyennes mobiles, etc.) réels au lieu de simulés — voir le journal
 *     de décision dans /areas/bvc-portfolio-manager.md côté app.
 *
 * Historique de la décision sur le choix des sources (honnêteté technique) :
 *  - idbourse.com/masi : cotations chargées par JavaScript, rien dans le
 *    HTML brut — abandonné.
 *  - casablanca-bourse.com (site OFFICIEL) : robots.txt interdit l'accès
 *    automatisé, règle respectée — abandonné.
 *  - marocboursier.com : widget TradingView en JavaScript, même problème
 *    qu'idbourse.com — abandonné.
 *
 * IMPORTANT — limites qui restent :
 *  - Aucune de ces sources n'est une API officielle garantie dans le temps.
 *  - Ce script ne fabrique aucune valeur : un titre non trouvé n'apparaît
 *    simplement pas dans le JSON du jour, et son historique garde un trou
 *    ce jour-là plutôt qu'une valeur inventée.
 *  - En cas d'échec total, aucun fichier n'est écrasé par un résultat vide.
 */

const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'bvc-data.json');
const HISTORY_PATH = path.join(__dirname, '..', 'data', 'history.json');
const MAX_HISTORY_DAYS = 900; // ~3.5 ans de jours de bourse, largement suffisant
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
  return { quotes, note: `Saisie manuelle: ${quotes.length} titres sur ${lines.filter(l => l.trim()).length} lignes fournies` };
}

// Liste des ~78 tickers cotés à la Bourse de Casablanca (reprise de l'app).
const BVC_TICKERS = ['ADH','ADI','AFI','AFM','AGM','AKT','ALM','ARD','ATH','ATL','ATW','BAL','BCI','BCP','BOA','CAP','CDM','CFG','CIH','CMA','CMG','CMT','COL','CRS','CSR','CTM','DHO','DIS','DLM','DRI','DWY','DYT','EQD','FBR','GAZ','GTM','HPS','IAM','IBC','IMO','INV','JET','LBV','LES','LHM','M2M','MAB','MDP','MIC','MLE','MNG','MOX','MSA','MUT','NEJ','NKL','OUL','PRO','RDS','REB','RIS','S2M','SAH','SAM','SBM','SID','SLF','SMI','SNA','SNP','SOT','SRM','STR','T2S','TGC','TMA','TQM','UMR','VCN','WAA','ZDJ'];

// ── Source : TradingView (API "scanner" publique) ──────────────────────────
async function fetchFromTradingView() {
  const tickers = BVC_TICKERS.map(t => `CSEMA:${t}`);
  const shards = ['global', 'africa', 'america'];

  for (const shard of shards) {
    const url = `https://scanner.tradingview.com/${shard}/scan`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols: { tickers, query: { types: [] } }, columns: ['close'] }),
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      console.log(`   [diag TradingView/${shard}] HTTP ${res.status} · ${text.length} caractères reçus`);
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
  return { quotes: [], note: 'TradingView: aucun shard n\'a renvoyé de données exploitables' };
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
    const occurrences = (html.match(/casabourse\.ma\/entreprise\//gi) || []).length;
    console.log(`   [diag casabourse.ma] HTTP ${res.status} · ${html.length} caractères · ${occurrences} liens entreprise/`);
    if (!res.ok) return { quotes: [], note: `casabourse.ma: HTTP ${res.status}` };
    if (!html || html.length < 5000) return { quotes: [], note: `casabourse.ma: réponse trop courte (${html.length})` };

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
    return { quotes, note: `casabourse.ma: ${quotes.length} valeurs extraites (sur ${occurrences} liens détectés)` };
  } catch (e) {
    return { quotes: [], note: `casabourse.ma: échec fetch — ${e.message}` };
  }
}

// ── Accumulation de l'historique réel (data/history.json) ─────────────────
function updateHistory(quotes, todayISO) {
  let hist = { days: [] };
  if (fs.existsSync(HISTORY_PATH)) {
    try { hist = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch { hist = { days: [] }; }
  }
  if (!Array.isArray(hist.days)) hist.days = [];

  const quotesMap = {};
  for (const q of quotes) quotesMap[q.ticker] = q.price;

  const existingIdx = hist.days.findIndex(d => d.date === todayISO);
  if (existingIdx >= 0) {
    hist.days[existingIdx].quotes = quotesMap; // ré-exécution le même jour → on remplace, pas de doublon
  } else {
    hist.days.push({ date: todayISO, quotes: quotesMap });
  }

  hist.days.sort((a, b) => a.date.localeCompare(b.date));
  if (hist.days.length > MAX_HISTORY_DAYS) {
    hist.days = hist.days.slice(hist.days.length - MAX_HISTORY_DAYS);
  }

  fs.writeFileSync(HISTORY_PATH, JSON.stringify(hist));
  return hist.days.length;
}

async function main() {
  const log = [];
  let quotes = [];
  let sourceUsed = '';

  const manual = parseManualData(process.env.MANUAL_DATA || '');
  log.push(manual.note);
  if (manual.quotes.length >= 5) { quotes = manual.quotes; sourceUsed = 'Saisie manuelle'; }

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
  console.log(`Total titres trouvés : ${quotes.length} (source: ${sourceUsed || 'aucune'})`);

  if (quotes.length < 5) {
    console.error(
      `⚠️ Moins de 5 titres trouvés (${quotes.length}). Aucun fichier modifié pour éviter d'écraser ` +
      `la dernière donnée valide par un résultat quasi-vide. Utilise la saisie manuelle (manual_data) si besoin.`
    );
    process.exitCode = 1;
    return;
  }

  const todayISO = new Date().toISOString().slice(0, 10);

  const payload = {
    generated_at: new Date().toISOString(),
    source_used: sourceUsed,
    source_log: log,
    quotes,
  };
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`✓ Écrit ${OUTPUT_PATH} (${quotes.length} titres)`);

  const totalDays = updateHistory(quotes, todayISO);
  console.log(`✓ Écrit ${HISTORY_PATH} (${totalDays} jour(s) réel(s) accumulé(s) au total, dont aujourd'hui ${todayISO})`);
}

main().catch(e => {
  console.error('Erreur fatale du scraper:', e);
  process.exitCode = 1;
});
