# Mise en place — automatisation des cours BVC (10 min, gratuit)

## Ce que ça fait
Un robot GitHub va, chaque jour ouvré à ~17h heure Maroc, aller chercher les
cours sur idbourse.com / casablanca-bourse.com et les écrire dans un fichier
`data/bvc-data.json`. Ton app BVC Portfolio Manager ira lire ce fichier au
chargement — **même si tu n'as jamais ouvert l'app la veille**.

## Étape 1 — Créer le repo
1. Va sur https://github.com/new
2. Nom du repo : `bvc-data` (ou ce que tu veux — note-le, il sert plus bas)
3. Visibilité : **Public** (obligatoire pour que `raw.githubusercontent.com`
   soit accessible sans authentification depuis ton app)
4. Ne coche rien d'autre, clique "Create repository"

## Étape 2 — Uploader les fichiers
Dans ton nouveau repo, utilise "Add file → Upload files" (dans le navigateur,
pas besoin de Git en ligne de commande) et dépose l'**arborescence complète**
fournie dans `github-pipeline/` :

```
.github/workflows/update-bvc.yml
scripts/scraper.js
data/bvc-data.json
```

⚠️ Respecte exactement ces chemins/dossiers — GitHub Actions ne détecte le
workflow que s'il est dans `.github/workflows/`.

## Étape 3 — Activer les Actions
1. Onglet "Actions" du repo → si un message demande d'activer les workflows,
   clique "I understand my workflows, go ahead and enable them"
2. Le workflow "Mise à jour cours BVC" doit apparaître dans la liste

## Étape 4 — Tester manuellement
1. Onglet "Actions" → clique sur "Mise à jour cours BVC"
2. Bouton "Run workflow" (à droite) → "Run workflow"
3. Attends ~30 secondes, actualise → clique sur le run pour voir les logs
4. Si tu vois `✓ Écrit .../bvc-data.json (XX titres)` → c'est bon
5. Si tu vois `⚠️ Moins de 10 titres trouvés` → les sites ont probablement
   changé de structure ; regarde les lignes de log juste au-dessus pour
   savoir laquelle (idbourse ou casablanca-bourse) a échoué et pourquoi.
   **Ne me redemande pas de "juste corriger" sans me montrer ce log** — c'est
   la seule façon d'ajuster le scraper sans deviner.

## Étape 5 — Récupérer l'URL et la coller dans l'app
Ton fichier de données est accessible à :
```
https://raw.githubusercontent.com/<TON_USER>/<TON_REPO>/main/data/bvc-data.json
```
Remplace `<TON_USER>` et `<TON_REPO>` par les tiens réels.

Dans `bvc-portfolio-manager-corrige.html`, cherche la ligne (près du début du
script, juste avant `const PROXY = ...`) :
```js
const GITHUB_DATA_URL = 'EDIT_ME_https://raw.githubusercontent.com/<user>/<repo>/main/data/bvc-data.json';
```
Remplace-la par ta vraie URL (sans "EDIT_ME_"), sauvegarde, et renvoie-moi le
fichier si tu veux que je vérifie l'intégration avant de le remettre en usage.

## Ce que ça NE fait PAS (limites honnêtes)
- Pas de données fondamentales (résultats, bilans, ratios détaillés) — il
  n'existe pas de source gratuite fiable et structurée pour l'ensemble de la
  cote BVC. L'app continue d'utiliser tes P/E, rendements et scores actuels.
- Si idbourse.com ou casablanca-bourse.com changent leur structure HTML, le
  scraper peut cesser de trouver des données — c'est le risque inhérent à
  toute extraction non-API. Le script est conçu pour ne jamais écraser une
  bonne donnée par une mauvaise (voir logs), mais il faudra parfois l'ajuster.
- Le workflow tourne 1x/jour après clôture, pas en intraday.
