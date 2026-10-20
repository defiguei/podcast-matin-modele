# Podcast du matin — notes de travail

Tout est en français : code, commentaires, messages, commits. L'application tutoie.

## Deux dépôts

- **Le modèle** (`defiguei/podcast-matin-modele`), public et « Template repository » : le code commun. On y code et on pousse directement sur `main`.
- **Les dépôts personnels** (`podcast-matin` de chacun, dont celui du propriétaire) se mettent à jour depuis le modèle : workflow `.github/workflows/mettre-a-jour.yml` (bouton « Mettre à jour » de l'application, ou lancé à la main) qui exécute `mise_a_jour.py`. On ne modifie pas un dépôt personnel directement : ce fichier y est recopié, donc si tu travailles dans un `podcast-matin`, fais le changement dans le modèle.
- Jamais copiés : `memoire.json`, `preferences.json`, `reglages.toml` (fichiers personnels). Les fichiers listés dans `version.json` → `supprimes` sont retirés chez chacun.
- Repères remplacés par le dépôt et l'adresse du bot de chacun : `REPERE_DEPOT` et `REPERE_HOTE` dans `mise_a_jour.py`. Ne les écrire que sous leur forme exacte (jamais échappés, ex. dans une expression régulière) ; dans `mise_a_jour.py` et les tests, les construire en morceaux. Un test vérifie qu'il n'en reste aucun après une mise à jour simulée.
- **Nouvelle version** : `VERSION` et `NOUVEAUTES` dans `cloudflare/src/etat.js`, même version dans `version.json` (un test compare). Les bots la proposent dans les 24 h. `NOUVEAUTES` est le message Telegram envoyé après le déploiement ; qui vient d'avant `VERSION_APPLICATION` reçoit `PRESENTATION` à la place (ne pas la changer pour une petite version).
- Le modèle n'a pas de secrets Cloudflare : « Déployer le bot » s'y arrête sur un avertissement. Ne jamais lui en donner (il remplacerait le bot du propriétaire).

## Architecture

- **Bot** (`cloudflare/`) : Cloudflare Worker + Durable Object `Etat` (stockage : `config`, `etat`, `cles`, `texte:*`).
  - `index.js` routes ; `etat.js` état, planning, tic, API ; `miniapp.js` données de l'application ; `app.html` l'application (une seule page) ; `config.js` modèle des réglages et des rubriques (`RUBRIQUES`, `deroule`, règles R1…, `sourcesAuto`) ; `connexions.js` clés et agendas ; `flux.js` flux RSS privé ; `services.js` Telegram, GitHub, Gemini ; `comprendre.js`, `assistant.js`, `ui.js` conversation Telegram ; `icones.js` icônes générées (`test/fabriquer_icones.py`).
  - Application : `/app/api`, ouverte par Telegram (initData signé) ou par un appareil autorisé (en-tête `X-Appareil`, code à 6 chiffres).
  - GitHub ↔ bot : `/api/*` avec `X-Podcast-Secret` = sha256(`podcast:` + jeton Telegram), 48 premiers caractères (`liaison.secret_partage`).
  - Clés saisies dans l'application : gardées par le bot, exportées aux exécutions GitHub (`liaison.appliquer_cles`, masquées dans les journaux) ; elles passent avant les secrets GitHub.
- **Épisodes** (GitHub Actions) : `podcast.py`, avec `regles.py`, `sources.py`, `trains.py`, `recherche.py`, `horaire.py` (filet de sécurité), `pays.py` et `donnees/pays.json` (profils CH, FR, BE partagés avec le bot).
- **Déploiement** (`deployer-bot.yml`) : tests, `wrangler deploy`, puis `cloudflare/secrets.mjs` transmet au bot les secrets GitHub qu'il n'a pas (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GEMINI_API_KEY`) et `BOT_GITHUB_TOKEN` comme `GITHUB_TOKEN`.

## Tests

- Bot : `cd cloudflare && npm ci && npm test` (wrangler dev sur 8799, faux services `test/faux.mjs` sur 8790 ; arrêter un aperçu en cours avant).
- Python : `pip install -r requirements.txt`, puis `python tests/test_podcast.py` et `python tests/test_regles.py`.
- Aperçu : `node test/apercu.mjs [reglages.json]` dans `cloudflare/`, puis http://127.0.0.1:8799/app (il faut un faux `Telegram.WebApp` pour l'ouvrir).
- Les tests tournent aussi sur GitHub à chaque envoi. `vider()` attend que le bot ait fini les messages déjà envoyés (`fini` de `/test/etat`) : sinon la fin d'une action déborde sur l'étape suivante. Pour vérifier qu'un test tient sur une machine lente : `FAUX_LENTEUR=200 npm test` (Telegram répond en 200 ms).
- Journaux GitHub Actions : `gh run view --log` ne marche pas ici ; lire les annotations (`gh api repos/…/check-runs/<job>/annotations`). `mise_a_jour.py` y laisse d'où vient son jeton et son résultat (notices).
