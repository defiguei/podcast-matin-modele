# Installer son Podcast du matin

Un podcast quotidien à deux voix, fabriqué chaque matin à partir de ton agenda et de l'actualité, livré sur Telegram, **gratuit** et sans ordinateur allumé. Compte 45 minutes à 1 heure la première fois.

## Ce qu'il te faut : 6 comptes ou clés

| # | Quoi | À quoi ça sert | Coût | Obligatoire |
|---|------|----------------|------|-------------|
| 1 | Compte **GitHub** | Héberge le code et fabrique les épisodes | Gratuit | Oui |
| 2 | Compte **Cloudflare** | Héberge le bot Telegram | Gratuit | Oui |
| 3 | Clé **Gemini** (Google AI Studio) | Écrit le dialogue et fait les voix | Gratuit | Oui |
| 4 | **Telegram** + un bot créé avec @BotFather | Reçoit les épisodes et se règle depuis ton téléphone | Gratuit | Oui |
| 5 | **Lien secret de ton agenda** (Google ou Outlook) | Lit ton agenda | Gratuit | Oui |
| 6 | Clé **Tavily** | Recherche sur internet pour les rubriques | Gratuit (1 000 recherches/mois) | Non, mais conseillé |

Ouvre un fichier texte et note chaque valeur au fur et à mesure : ce sont des secrets, ne les publie nulle part et ne les envoie à personne.

---

## Étape 1 · Créer les comptes et récupérer les clés

### 1. GitHub
Crée un compte sur github.com. Crée ensuite ton dépôt **privé** `podcast-matin` à partir du modèle (bouton **Use this template**) ou en y glissant les fichiers reçus.

### 2. Cloudflare
Crée un compte sur dash.cloudflare.com (pas besoin de carte bancaire ni de nom de domaine). Récupère deux valeurs :
- **Account ID** : *Workers & Pages* → à droite de la page d'accueil. Copie-le.
- **Jeton d'API** : ta photo → *My Profile* → *API Tokens* → *Create Token* → modèle **Edit Cloudflare Workers** → *Use template*. *Account Resources* : ton compte ; *Zone Resources* : *All zones* → *Continue to summary* → *Create Token*. Copie le jeton tout de suite (il n'est montré qu'une fois).
- Ouvre *Workers & Pages* : si Cloudflare te demande de choisir un **sous-domaine** `xxx.workers.dev`, choisis-le et note-le. Ton bot sera à l'adresse `https://podcast.XXX.workers.dev`.

### 3. Clé Gemini
Va sur aistudio.google.com/apikey, connecte-toi avec un compte Google, *Create API key*, copie la clé. Le quota gratuit suffit (quelques requêtes par jour).

### 4. Bot Telegram
Dans Telegram, cherche **@BotFather** → `/newbot` → un nom, puis un identifiant qui finit par `bot` (ex. `alice_podcast_bot`). BotFather te donne un **jeton** (`123456:ABC…`) : copie-le. Ouvre ensuite ton nouveau bot et appuie sur **Démarrer**.

### 5. Lien secret de ton agenda
- **Google Agenda** (navigateur, version ordinateur) : ⚙️ Paramètres → clique sur ton agenda → *Intégrer l'agenda* → copie l'**adresse secrète au format iCal**.
- **Outlook / Microsoft 365** : ⚙️ Paramètres → Calendrier → Calendriers partagés → *Publier un calendrier* → « Peut afficher tous les détails » → copie le **lien ICS**. (Certaines entreprises bloquent cette publication : demande alors à ton service informatique, ou utilise seulement ton agenda personnel.)
- Plusieurs agendas : mets les liens à la suite, séparés par un espace. Ce lien donne accès à ton agenda : garde-le secret.

### 6. Clé Tavily (facultative)
Crée un compte sur app.tavily.com, copie la clé (`tvly-…`). Sans elle, le podcast marche, mais les rubriques qui cherchent sur internet (idées de sortie, fêtes du jour par recherche…) seront pauvres.

### Un jeton GitHub pour le bot (7e valeur)
Le bot doit pouvoir lancer les épisodes sur GitHub. Sur GitHub : ta photo → *Settings* → *Developer settings* → *Personal access tokens* → *Fine-grained tokens* → *Generate new token*. *Repository access* : **Only select repositories** → `podcast-matin`. *Permissions* → *Repository permissions* : **Actions** et **Contents** en *Read and write*. Copie le jeton.

---

## Étape 2 · Configurer GitHub

Dans ton dépôt : *Settings* → *Secrets and variables* → *Actions*.

**Onglet Secrets → New repository secret**, un par ligne :

| Nom exact | Valeur |
|---|---|
| `GEMINI_API_KEY` | clé Gemini |
| `TELEGRAM_BOT_TOKEN` | jeton de @BotFather |
| `CALENDAR_ICS_URL` | lien(s) d'agenda |
| `TAVILY_API_KEY` | clé Tavily (laisse vide si tu n'en as pas) |
| `SNCF_API_KEY` | clé gratuite de l'API SNCF, seulement pour suivre un train en France ([numerique.sncf.com/startup/api](https://numerique.sncf.com/startup/api/)) ; la Suisse et la Belgique n'en ont pas besoin |
| `CLOUDFLARE_API_TOKEN` | jeton Cloudflare |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID Cloudflare |

(`TELEGRAM_CHAT_ID` s'ajoute à l'étape 4.)

**Onglet Variables → New repository variable :** `BOT_URL` = `https://podcast.XXX.workers.dev` (avec ton sous-domaine).

Rien à modifier dans les fichiers : le nom de ton dépôt et l'adresse du bot sont transmis automatiquement au déploiement.

## Étape 3 · Mettre le bot en ligne

1. Onglet **Actions** → *Déployer le bot* → *Run workflow*. Les tests tournent, puis le bot est mis en ligne (le Worker `podcast` est créé chez Cloudflare). Si le message est orange, il manque `CLOUDFLARE_API_TOKEN` ou `CLOUDFLARE_ACCOUNT_ID`.
2. Dans Cloudflare : *Workers & Pages* → **podcast** → *Settings* → *Variables and Secrets* → ajoute, en type **Secret** :
   - `TELEGRAM_BOT_TOKEN` : jeton de @BotFather ;
   - `GEMINI_API_KEY` : clé Gemini ;
   - `GITHUB_TOKEN` : le jeton GitHub du bot ;
   - `TELEGRAM_CHAT_ID` : à l'étape 4.

## Étape 4 · Premier essai

1. Dans Telegram, cherche le bot **@userinfobot**, appuie sur **Démarrer** : il répond avec ton **Id** (un nombre, par exemple `123456789`). C'est ton identifiant de conversation.
2. Ajoute ce nombre comme secret `TELEGRAM_CHAT_ID`, **dans GitHub** (*Settings* → *Secrets and variables* → *Actions*) **et dans Cloudflare** (*Workers & Pages* → **podcast** → *Settings* → *Variables and Secrets* → type **Secret**).
3. Relance *Déployer le bot*, puis *Podcast du matin*. Tu reçois ton premier épisode et le clavier de réglages.

## Étape 5 · Régler à ton goût (depuis Telegram)

Tout se règle en écrivant à ton bot ou avec ses boutons : heure d'envoi par jour, durée, voix, prénom, ville, sujets préférés ou à éviter, agendas à lire, **rubriques** (le saint du jour, une idée de sortie, un sujet suivi…), consignes. Tape `/aide`.

Pour une autre région que la Suisse romande, modifie dans `reglages.toml` (✏️ sur GitHub) : `fuseau_horaire`, `pays_actus`, `langue_actus`.

## En cas de souci

| Souci | Que faire |
|---|---|
| Pas d'épisode | Actions → l'exécution en rouge → lis le message en haut. |
| « La clé Gemini est refusée » | Recopie `GEMINI_API_KEY` sans espace. |
| « agenda inaccessible » | Le lien a changé : recopie-le dans `CALENDAR_ICS_URL`. |
| Le bot ne répond plus | Ouvre `https://podcast.XXX.workers.dev/installer` dans ton navigateur. |
| « Recherche web : non configurée » | Ajoute `TAVILY_API_KEY`. |
| « temps réel SNCF non configuré » (journal) | Ajoute `SNCF_API_KEY` pour les trains en France. |

**Confidentialité :** Google reçoit le titre, l'heure et le lieu de tes rendez-vous pour écrire l'épisode ; Tavily reçoit les recherches de tes rubriques. Tes clés ne sont que dans les secrets GitHub et Cloudflare, jamais dans le code. Garde ton dépôt **privé**.
