# Mettre à jour son Podcast du matin

Le code commun vit dans le **modèle** ([defiguei/podcast-matin-modele](https://github.com/defiguei/podcast-matin-modele)). Chaque personne a son propre dépôt privé `podcast-matin`, qui se met à jour depuis le modèle.

Une mise à jour remplace le code, jamais ce qui t'appartient :

- tes **réglages** (horaires, voix, rubriques, consignes, clés, agendas) vivent dans ton bot Cloudflare, qui les garde ;
- `memoire.json`, `preferences.json` (sauvegarde de tes réglages) et `reglages.toml` ne sont jamais touchés ;
- tes **secrets** GitHub et Cloudflare restent en place.

---

## Ensuite, toujours : le bouton

Quand le modèle publie une nouvelle version, l'accueil de l'application affiche **Nouvelle version disponible** (le bot vérifie une fois par jour). Ouvre **Réglages › Application › Version** : la liste des nouveautés s'affiche, avec le bouton **Mettre à jour**. Compte deux à trois minutes, puis rouvre l'application.

Pour que le bouton mette aussi à jour les fichiers d'automatisation (`.github/workflows/`), le jeton GitHub du bot doit avoir la permission **Workflows** (voir plus bas). Sans elle, tout le reste se met à jour quand même, et un message te le signale.

---

## La première fois (installations d'avant l'application)

Si ton podcast se règle encore en écrivant au bot dans Telegram, ton dépôt n'a pas encore le bouton. Cette première mise à jour se fait à la main, une seule fois, en 10 minutes environ. Ton podcast continue de marcher pendant ce temps.

### 1. Un jeton GitHub avec la permission « Workflows »

Sur GitHub : ta photo → *Settings* → *Developer settings* → *Personal access tokens* → *Fine-grained tokens* → *Generate new token*.
- *Expiration* : la plus longue possible (ou *No expiration*) ;
- *Repository access* : **Only select repositories** → ton dépôt `podcast-matin` ;
- *Permissions* → *Repository permissions* : **Actions**, **Contents** et **Workflows** en *Read and write*.

*Generate token*, copie-le, puis dans ton dépôt : *Settings* → *Secrets and variables* → *Actions* → *New repository secret* → nom **`BOT_GITHUB_TOKEN`**, valeur : le jeton.

Ce jeton servira aussi à ton bot : le prochain déploiement le lui transmet tout seul (il remplace l'ancien jeton rangé chez Cloudflare, que tu pourras ensuite supprimer sur GitHub).

### 2. Ajouter le fichier de mise à jour

Dans ton dépôt : **Add file** → **Create new file**.
- Nom du fichier : `.github/workflows/mettre-a-jour.yml` (tape le nom complet, les `/` créent les dossiers) ;
- Contenu : ouvre [le fichier du modèle](https://github.com/defiguei/podcast-matin-modele/blob/main/.github/workflows/mettre-a-jour.yml), touche l'icône **Copy raw file**, et colle.

*Commit changes…* → *Commit changes*.

### 3. Lancer la mise à jour

Onglet **Actions** → *Mettre à jour* (à gauche) → **Run workflow** → laisse les champs vides → **Run workflow**.

Le code du modèle est recopié dans ton dépôt, puis *Déployer le bot* démarre tout seul (deux à trois minutes). Ton bot t'écrit alors dans Telegram, avec le bouton **Ouvrir l'application**.

### 4. Vérifier dans l'application

- **Réglages › Moi** : le pays a été déduit de ton installation (France si ton fuseau était Paris). Corrige-le au besoin : heure, jours fériés, devise et médias suivent.
- **Épisode** : tes rubriques et les rubriques fournies sont réunies, dans l'ordre de l'épisode.
- **Réglages › Durée et style** : une consigne qui parle d'un rendez-vous est signalée ; *En faire un rappel* la transforme en rubrique, plus fiable.
- **Réglages › Connexions** : tes secrets GitHub (`GEMINI_API_KEY`, `CALENDAR_ICS_URL`, `TAVILY_API_KEY`) continuent de marcher. Tu peux y coller tes clés et tes agendas pour les régler depuis l'application ; elles passent alors avant les secrets.

### Si quelque chose coince

| Souci | Que faire |
|---|---|
| *Mettre à jour* en rouge : « le modèle n'est pas accessible » | Le modèle n'est pas encore public : réessaie plus tard. |
| Message « Fichiers d'automatisation non mis à jour » | Le secret `BOT_GITHUB_TOKEN` manque ou n'a pas la permission *Workflows* : corrige-le (étape 1), puis relance *Mettre à jour* à la main (étape 3). |
| *Déployer le bot* en orange | Il manque `CLOUDFLARE_API_TOKEN` ou `CLOUDFLARE_ACCOUNT_ID` (voir [INSTALLATION.md](INSTALLATION.md), étape 2). |
| Pas de message du bot après le déploiement | Ouvre `https://podcast.TON-SOUS-DOMAINE.workers.dev/installer` dans ton navigateur. |

Relancer *Mettre à jour* ne fait jamais de mal : quand tout est déjà à jour, rien ne change.

---

## Pour le modèle : publier une version

1. Changer `VERSION` et `NOUVEAUTES` dans `cloudflare/src/etat.js` (format `AAAA-MM-JJ.n`).
2. Mettre la même version dans `version.json`, avec ses nouveautés (affichées dans l'application) et, dans `supprimes`, les fichiers à retirer chez chacun.
3. Envoyer sur `main` : les tests vérifient que les deux versions concordent. Les bots la proposent dans les 24 heures.

Le modèle doit rester **public** : les dépôts privés de chacun y lisent `version.json` et le code. Les fichiers contiennent des repères (`TON-COMPTE/podcast-matin`, `podcast.TON-SOUS-DOMAINE.workers.dev`) que la mise à jour remplace par le dépôt et l'adresse du bot de chacun.
