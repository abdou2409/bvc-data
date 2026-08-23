name: Mise à jour cours BVC

on:
  schedule:
    # 16:00 UTC = 17:00 heure Maroc standard (UTC+1) ou 16:00 pendant les
    # semaines où le Maroc repasse temporairement à UTC+0 (ex. Ramadan).
    # Dans les deux cas, c'est APRÈS la clôture de la Bourse de Casablanca
    # (15h30 heure locale). Lun-Ven uniquement (jours de bourse).
    - cron: '0 16 * * 1-5'
  workflow_dispatch: {}   # permet de déclencher manuellement depuis l'onglet Actions

permissions:
  contents: write

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Exécuter le scraper
        run: node scripts/scraper.js

      - name: Commit et push si data/bvc-data.json a changé
        run: |
          git config user.name "bvc-bot"
          git config user.email "bvc-bot@users.noreply.github.com"
          git add data/bvc-data.json
          git diff --staged --quiet || git commit -m "Mise à jour cours BVC $(date -u +%Y-%m-%d)"
          git push
