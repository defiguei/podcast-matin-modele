# Installer son Podcast du matin

Un podcast quotidien à deux voix, fabriqué chaque matin à partir de ton agenda et de l'actualité, **gratuit** et sans ordinateur allumé. Compte 30 à 45 minutes la première fois. Les clés des services (Gemini, Tavily) et tes agendas se règlent ensuite dans l'application : ici, il ne s'agit que de mettre le bot en ligne.

## Ce qu'il te faut

| Quoi | À quoi ça sert | Coût |
|------|----------------|------|
| Un compte **GitHub** | Héberge le code et fabrique les épisodes | Gratuit |
| Un compte **Cloudflare** | Héberge le bot et l'application | Gratuit, sans carte bancaire |
| **Telegram** et un bot créé avec @BotFather | Ouvre l'application et reçoit les épisodes | Gratuit |
| Une clé **Gemini** (Google AI Studio) | Écrit et dit l'épisode ; elle se colle dans l'application | Gratuit |

Ouvre un fichier texte et note chaque valeur au fur et à mesure : ce sont des secrets, ne les publie nulle part.

---

## Étape 1 · Ton dépôt GitHub

Crée un compte sur github.com, puis ouvre le modèle [github.com/defiguei/podcast-matin-modele](https://github.com/defiguei/podcast-matin-modele) → bouton vert **Use this template** → *Create a new repository*. Nom : `podcast-matin`, visibilité **Private** → *Create repository*.

## Étape 2 · Les valeurs à récupérer

### Cloudflare (2 valeurs)
Crée un compte sur dash.cloudflare.com.
- **Account ID** : *Workers & Pages* → à droite de la page. Copie-le.
- **Jeton d'API** : ta photo → *My Profile* → *API Tokens* → *Create Token* → modèle **Edit Cloudflare Workers** → *Use template*. *Account Resources* : ton compte ; *Zone Resources* : *All zones* → *Continue to summary* → *Create Token*. Copie le jeton tout de suite (il n'est montré qu'une fois).
- Dans *Workers & Pages*, si Cloudflare te demande un **sous-domaine** `xxx.workers.dev`, choisis-le et note-le : ton bot sera à l'adresse `https://podcast.xxx.workers.dev`.

### Telegram (2 valeurs)
- Dans Telegram, cherche **@BotFather** → `/newbot` → un nom, puis un identifiant qui finit par `bot` (ex. `alice_podcast_bot`). BotFather donne un **jeton** (`123456:ABC…`) : copie-le. Ouvre ton nouveau bot et appuie sur **Démarrer**.
- Cherche **@userinfobot** → **Démarrer** : il répond avec ton **Id** (un nombre, ex. `123456789`). C'est ton identifiant de conversation.

### Un jeton GitHub pour le bot (1 valeur)
Le bot lance les épisodes sur GitHub et y installe les mises à jour. Sur GitHub : ta photo → *Settings* → *Developer settings* → *Personal access tokens* → *Fine-grained tokens* → *Generate new token*.
- *Expiration* : la plus longue possible (ou *No expiration*) ;
- *Repository access* : **Only select repositories** → `podcast-matin` ;
- *Permissions* → *Repository permissions* : **Actions**, **Contents** et **Workflows** en *Read and write*.

*Generate token*, puis copie-le.

## Étape 3 · Ranger les secrets dans GitHub

Dans ton dépôt `podcast-matin` : *Settings* → *Secrets and variables* → *Actions*.

**Onglet Secrets → New repository secret**, un par ligne :

| Nom exact | Valeur |
|---|---|
| `TELEGRAM_BOT_TOKEN` | jeton de @BotFather |
| `TELEGRAM_CHAT_ID` | ton Id donné par @userinfobot |
| `BOT_GITHUB_TOKEN` | le jeton GitHub du bot |
| `CLOUDFLARE_API_TOKEN` | jeton Cloudflare |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID Cloudflare |

**Onglet Variables → New repository variable :** `BOT_URL` = `https://podcast.xxx.workers.dev` (avec ton sous-domaine).

C'est tout : rien à taper chez Cloudflare, rien à modifier dans les fichiers. Le déploiement transmet ces secrets au bot, avec le nom de ton dépôt et son adresse.

## Étape 4 · Mettre le bot en ligne

Onglet **Actions** → *Déployer le bot* → *Run workflow*. Les tests tournent, le bot est mis en ligne et reçoit ses secrets, puis il s'active : ton bot t'écrit dans Telegram. Si le message est orange, il manque `CLOUDFLARE_API_TOKEN` ou `CLOUDFLARE_ACCOUNT_ID`.

## Étape 5 · L'application

Dans la conversation avec ton bot, touche **Application** (à gauche du champ de saisie). Le premier lancement te guide en cinq étapes : ton prénom, ta ville et ton pays, l'heure de l'épisode, ton agenda (adresse secrète iCal de Google Agenda ou d'Outlook), et ta **clé Gemini** ([aistudio.google.com/apikey](https://aistudio.google.com/apikey) → *Create API key*). Touche enfin **Générer mon premier épisode**.

Ensuite, tout se règle dans l'application : rubriques (onglet Épisode), horaires (Planning), voix, style, clés (Réglages › Connexions). La clé **Tavily** (facultative, gratuite sur app.tavily.com) améliore les idées de sortie.

> Facultatif : range aussi ta clé Gemini en secret GitHub `GEMINI_API_KEY`. Si le bot était un jour injoignable, le filet de sécurité de GitHub pourrait quand même fabriquer l'épisode.

---

## En cas de souci

| Souci | Que faire |
|---|---|
| Pas de message du bot après le déploiement | Ouvre `https://podcast.xxx.workers.dev/installer` dans ton navigateur. |
| *Déployer le bot* signale un secret manquant | Ajoute le secret nommé (étape 3), puis relance *Déployer le bot*. |
| Pas d'épisode | Onglet *Actions* → l'exécution en rouge → lis le message en haut. |
| « La clé Gemini manque » ou « est refusée » | Réglages › Connexions : colle la clé, touche *Tester*. |
| « agenda inaccessible » | L'adresse iCal a changé : retire l'agenda et ajoute la nouvelle. |
| Une mise à jour ne touche pas aux fichiers d'automatisation | Le jeton GitHub du bot n'a pas la permission *Workflows* : voir [MISE-A-JOUR.md](MISE-A-JOUR.md). |

**Confidentialité :** Google reçoit le titre, l'heure et le lieu de tes rendez-vous pour écrire l'épisode ; Tavily reçoit les recherches de tes rubriques. Tes clés restent chez ton bot et dans les secrets GitHub, jamais dans le code. Garde ton dépôt **privé**.
