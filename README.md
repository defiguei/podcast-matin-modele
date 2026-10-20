# 🎙️ Podcast du matin

Chaque matin, un épisode audio personnel arrive sur ton téléphone, dans Telegram. Deux animateurs parlent de ton agenda, des actualités qui t'intéressent, et de tout ce que tu leur as demandé : le saint du jour, des idées de sortie pour samedi, une rando par beau temps…

- **Tout se règle dans Telegram**, en écrivant, en dictant ou avec des boutons : l'heure de chaque jour, la durée, les voix, l'ordre des rubriques, les sources, tes rubriques.
- **Des rubriques**, comme « le vendredi, propose une sortie entre amis à Lausanne, 30 CHF max » ou « la veille d'un match, rappelle-moi le sac de foot ».
- **Un assistant de recherche** te pose les bonnes questions (quoi, avec qui, où, quand, transport, budget), puis te répond dans le podcast, par écrit avec photos et carte, ou en mini-podcast.

Ton ordinateur et ton NAS n'ont pas besoin d'être allumés, et aucune IA ne tourne chez toi. **Coût : 0 CHF** (offres gratuites de Cloudflare, GitHub, Gemini, Tavily et Telegram).

---

## Ton bot 💬

En bas de la conversation, quatre boutons restent toujours là : **🎙️ Podcast**, **⚙️ Réglages**, **📌 Rubriques** et **🔎 Recherche**. Le bouton **Application**, à gauche du champ de saisie, ouvre l'application du podcast (voir plus bas). Les commandes s'affichent en tapant « / » (`/menu`, `/podcast`, `/rubriques`, `/recherche`, `/planning`, `/reglages`, `/annuler`, `/aide`). Un **tableau de bord** épinglé en haut de la conversation résume tout, et se met à jour tout seul.

Tu peux aussi simplement écrire, ou envoyer un vocal :

| Tu dis | Effet |
|---|---|
| « 6 h 45 en semaine, 9 h le samedi, rien le dimanche » | Horaire jour par jour |
| « Demain exceptionnellement à 5 h 30 », « pas d'épisode du 20 au 27 » | Exception, pause |
| « Des épisodes de 4 minutes, un peu plus lentement » | Durée, vitesse |
| « Plus d'humour », « vouvoie-moi », « appelle-moi Daniel » | Ton, tutoiement, prénom |
| « Mets les actus avant l'agenda », « supprime la clôture » | Déroulé de l'épisode |
| « Le sport ne m'intéresse pas », « ajoute 24 heures comme source » | Thèmes, sources d'actus |
| « Chaque jour, dis-moi le saint du jour entre l'agenda et les news » | Nouvelle rubrique (voir plus bas) |
| « Creuse le deuxième sujet demain » | Approfondissement au prochain épisode |
| « Refais le podcast » | Nouvel épisode tout de suite (6 par jour au plus) |

Chaque changement est confirmé avec un bouton **↩️ Annuler**.

**Sous chaque épisode** : 👍 👎, *Plus court*, *Plus long*, *Moins vite*, *Plus vite*, *🔎 Sujet 1, 2, 3* (à creuser demain), *📝 Texte* (la transcription), *🔁 Refaire*. Après un 👎, le bot demande ce qui n'allait pas et s'adapte. Une réaction 👍 ou 👎 posée sur l'épisode compte aussi. La légende donne les **chapitres** (0:00 Ouverture · 0:25 Agenda…), et la pochette change chaque jour.

**⚙️ Réglages** ouvre des menus qui se modifient sur place : 📅 Planning (heure par jour, exceptions, pauses, jours fériés vaudois, 🔁 rattrapage avec délai réglable de 30 min à 2 h ou désactivé, préparation en avance), 🎙️ Format, 🗣️ Voix (30 voix, extraits audio pour choisir), 🧩 Déroulé (la liste de tes rubriques par leur nom : touche-en une pour régler ses paramètres, ⬆ ⬇ ⏸), 🗓️ Agenda (dont 📚 la liste de tes agendas, à cocher), 📰 Actus (ville, thèmes, sources RSS, âge des nouvelles, citer les sources à l'oral ou par écrit), ✍️ Consignes (une phrase transmise telle quelle à l'IA pour tous les épisodes ; modifiable).

**Partage ta position** (📎 → Position) : elle devient ta ville, ou le point de départ d'une recherche.

---

## L'application 📱

Tout le podcast se règle dans une application qui s'ouvre **dans Telegram**, sur Android comme sur iPhone, sans rien installer : touche **Application** à gauche du champ de saisie, ou **🎧 Ouvrir dans l'application** sous l'épisode du matin. Dans **Réglages › Application**, tu peux aussi ajouter une icône sur l'écran d'accueil de ton téléphone. L'application est servie gratuitement par le même Cloudflare que le bot, et seul ton compte Telegram peut l'ouvrir (Telegram signe chaque ouverture, le bot vérifie la signature).

- **Accueil** : prochain épisode (*Générer maintenant*, *Sauter*), lecteur de l'épisode avec chapitres cliquables, 👍 👎, idées trouvées par tes recherches, les 7 prochains jours, et **« Demande-moi quelque chose »** pour tout régler en une phrase, écrite ou dite au micro.
- **Épisodes** : une miniature par épisode, faite de photos libres de Wikipédia qui illustrent les sujets du jour ; les dates dans l'ordre chronologique ; un calendrier de tous les épisodes (deux mois d'historique). Pour chacun : lecteur, chapitres, sources rangées par section, avis, *Plus court*, *Plus long*, *Moins vite*, *Plus vite*, sujets à creuser, texte complet.
- **Rubriques** : actives, à venir, en pause ; une fiche complète par rubrique (y compris budget, transport, à inclure ou exclure) ; **recherches ponctuelles** de sorties ou d'activités, lancées par écrit ou en mini-podcast.
- **Déroulé** : glisser-déposer et pause de chaque passage.
- **Planning** : heure et activation de chaque jour, jours fériés, rattrapage, exceptions, pauses, calendrier.
- **Réglages** : format, voix (avec extraits à écouter), actualités, sources, agenda et agendas lus, consignes, sujets à creuser.

Chaque changement s'annule depuis l'accueil (*Annuler*) ou avec `/annuler`. La conversation reste calme : l'épisode du matin y arrive, avec un bouton vers l'application. Tu peux toujours y écrire si tu préfères.

---

## Les rubriques 📌

Une rubrique est un passage de ton épisode, avec ses propres paramètres. Elles sont numérotées R1, R2… dans l'ordre : quand tu en supprimes une, les suivantes remontent. Les rubriques intégrées (🏠 Actu locale, 🧳 Déplacements et sorties, 🔎 À creuser) se règlent aussi depuis le Déroulé. Une rubrique a :

- une **consigne** (« dis-moi le saint du jour ») ;
- une **période** : toujours, certains jours, entre deux dates, une seule fois, ou « ponctuelle » (une recherche hors podcast) ;
- parfois une **condition d'agenda** : « la veille d'un match », « 3 jours avant un voyage » ;
- une **place** dans le déroulé (après quelle rubrique) et une longueur (une phrase, courte, développée) ;
- pour les sorties, une **fiche de recherche** : quoi, avec qui (âges), où (« autour de Morges », « entre Yverdon et Neuchâtel »), quand, transport (voiture, train, vélo, à pied), **budget maximum** (par personne ou pour le groupe, transport compris ou non), à inclure ou exclure ;
- ses **sources** (voir plus bas) et une importance (⭐ prioritaire).

Exemples :

- « Chaque jour, le saint du jour après l'agenda » → source : calendrier des saints, une phrase.
- « Samedi, une sortie avec les enfants (6 et 9 ans) autour d'Yverdon, en train, moins de 20 CHF par personne » → recherche web, météo du samedi, trains CFF, lieux à proximité ; présentée dans les épisodes des 3 jours avant.
- « Une rando dans le Jura vaudois par beau temps » → météo, sommets, points de vue, Wikivoyage.
- « L'actu culturelle de Lausanne, sans tenir compte de la météo » → recherche web, actualités.
- « La veille d'un match de foot, rappelle-moi de préparer mon sac » → l'agenda est vérifié chaque matin.

Dans **📌 Rubriques**, chaque rubrique a sa fiche : ✏️ titre et consigne, 📅 période, ⏰ condition d'agenda, 🧩 place et longueur, 🔎 recherche (quoi, avec qui, âges, où, rayon, quand, 🚗 transport, 💰 budget, à inclure/exclure, résultat attendu, recherches web, 📡 sources), ⭐ importance, ⏸ pause, 🗑 supprimer, et **📝 Résultats écrits** ou **🎧 Mini-podcast** tout de suite. Coche plusieurs rubriques (☐) pour les traiter ensemble.

### L'assistant de recherche 🔎

« Je veux organiser un truc samedi avec des amis » : l'assistant complète la fiche avec toi, une question à la fois (avec des boutons, ou en écrivant), puis te montre un résumé. Tu choisis ensuite :

- **🔍 Approfondir** : quelques questions de plus (durée, niveau de marche, intérieur…) ;
- **✅ Enregistrer** : les idées viendront dans tes podcasts des jours précédents ;
- **📝 Résultats écrits** : 3 à 5 idées, chacune avec photo, prix, horaires, accès, lien, lieu sur la carte et bouton 🗺️ Itinéraire, puis un **sondage** « Laquelle te tente ? » et un bouton **📋 Copier pour mes amis** ;
- **🎧 Mini-podcast** : les mêmes idées racontées par les deux voix.

Après un vote au sondage, tu peux demander plus de détails, en parler au prochain épisode, ou garder l'idée dans la rubrique.

### Les sources

| Source | Ce qu'elle apporte | Clé |
|---|---|---|
| Recherche web (Tavily) | Événements, prix, horaires, programmes | Gratuite (1 000 recherches par mois) : secret `TAVILY_API_KEY` |
| Open-Meteo | Météo jusqu'à 15 jours | Aucune |
| transport.opendata.ch | Horaires des trains suisses (pas les prix) | Aucune |
| OpenStreetMap | Musées, grottes, aires de jeux, piscines, points de vue… autour d'un lieu | Aucune |
| Wikivoyage, Wikipédia | Présentation d'un lieu, photos | Aucune |
| Calendrier des saints | Saints et fêtes du jour (data.gouv.fr) | Aucune |
| Fêtes du jour | Fêtes nationales et journées internationales (Wikipédia) | Aucune |
| Jours fériés vaudois | Calculés | Aucune |
| Actualités | Google Actualités et tes flux RSS | Aucune |

Les faits précis (prix, horaires, dates) viennent des sources. Quand une information manque, les animateurs le disent plutôt que de l'inventer.

---

> **Partager ou installer pour quelqu'un d'autre ?** Voir [docs/PARTAGER.md](docs/PARTAGER.md) (préparer une copie propre) et [docs/INSTALLATION.md](docs/INSTALLATION.md) (comptes à créer et clés à récupérer).

## Comment ça marche

- **Le bot** (dossier `cloudflare/`) tourne gratuitement chez Cloudflare. Il répond tout de suite, garde tes réglages et tes rubriques, et **lance chaque épisode à l'heure prévue**. Il sauvegarde tout chaque nuit dans `preferences.json`.
- **GitHub fabrique les épisodes** (`podcast.py`) : il lit tes réglages auprès du bot, ton agenda, les actus et les sources de tes rubriques, fait écrire le dialogue par Gemini, le met en voix et te l'envoie.
- **Gemini** comprend tes messages (modèles « Lite », quotas larges) et écrit les épisodes (modèles « Flash », avec repli sur les « Lite » si besoin).
- **Filet de sécurité** : si l'épisode n'est pas parti une heure après l'heure prévue, le bot relance un essai ; si le bot lui-même était en panne, GitHub prépare l'épisode à partir de la sauvegarde.

---

## Passer à la version 3 (une seule fois, ≈ 10 minutes)

Le bot actuel continue de marcher pendant ce temps : rien ne casse si tu le fais plus tard.

1. **Jeton Cloudflare.** Sur dash.cloudflare.com : ta photo → *Profile* → *API Tokens* → *Create Token* → modèle **Edit Cloudflare Workers** → *Use template*. Dans *Account Resources*, choisis ton compte ; dans *Zone Resources*, *All zones*. → *Continue to summary* → *Create Token*. Copie le jeton (il n'est affiché qu'une fois).
2. **Identifiant de compte Cloudflare.** Page d'accueil du tableau de bord → *Workers & Pages* : l'**Account ID** est affiché à droite. Copie-le.
3. **Secrets GitHub** : dans ton dépôt, *Settings* → *Secrets and variables* → *Actions* → *New repository secret*. Crée :
   - `CLOUDFLARE_API_TOKEN` : le jeton de l'étape 1 ;
   - `CLOUDFLARE_ACCOUNT_ID` : l'identifiant de l'étape 2 ;
   - `TAVILY_API_KEY` : ta clé Tavily (app.tavily.com).
4. **Déploiement** : onglet *Actions* → *Déployer le bot* → *Run workflow*. Il teste le bot, le met en ligne, puis l'active. Ton bot t'envoie alors « 🎉 Nouvelle version », avec le clavier et le tableau de bord.

Les secrets du bot lui-même (jetons Telegram, GitHub, clé Gemini) restent dans Cloudflare : le déploiement ne les touche pas. Ensuite, chaque changement du dossier `cloudflare/` est déployé tout seul.

---

## Mise en place depuis zéro

Il te faut un compte GitHub, un compte Cloudflare, ta clé API Gemini ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)), une clé Tavily (facultative) et l'app Telegram.

1. **Bot Telegram** : dans Telegram, **@BotFather** → `/newbot` → un nom, puis un identifiant qui finit par `bot`. Garde le **jeton**. Ouvre ton bot et appuie sur **Démarrer**.
2. **Lien secret de ton agenda** (il ne va que dans les secrets) :
   - **Google Agenda** (navigateur, version ordinateur) : ⚙️ Paramètres → ton agenda → *Intégrer l'agenda* → **adresse secrète au format iCal**.
   - **Outlook / Microsoft 365** : ⚙️ Paramètres → Calendrier → Calendriers partagés → *Publier un calendrier* → « Peut afficher tous les détails » → **lien ICS**.
   - Plusieurs agendas : mets plusieurs liens, séparés par un espace.
3. **Dépôt GitHub** privé `podcast-matin` avec les fichiers du projet.
4. **Secrets GitHub** (*Settings* → *Secrets and variables* → *Actions*) : `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `CALENDAR_ICS_URL`, `TAVILY_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Le secret `TELEGRAM_CHAT_ID` vient à l'étape 6.
5. **Worker Cloudflare** : *Workers & Pages* → *Create* → nom **podcast**. Dans ses *Settings* → *Variables and Secrets*, ajoute en type *Secret* : `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GEMINI_API_KEY`, et `GITHUB_TOKEN` (*Fine-grained token* limité à `podcast-matin`, permissions *Actions* et *Contents* en *Read and write*).
6. **Premier essai** : onglet *Actions* → *Podcast du matin* → *Run workflow*. Le bot t'envoie ton identifiant de conversation : ajoute-le comme `TELEGRAM_CHAT_ID` (dans GitHub et dans Cloudflare).
7. **Déploiement du bot** : *Actions* → *Déployer le bot* → *Run workflow*.

Si ton Worker n'a pas l'adresse `podcast.TON-SOUS-DOMAINE.workers.dev`, mets la bonne dans `cloudflare/wrangler.toml` (`ADRESSE`) et dans une variable GitHub `BOT_URL`.

---

## Bon à savoir

- **Gratuité.**
  - GitHub : environ 4 minutes par épisode, plus quelques secondes pour chaque filet de sécurité ; largement dans les 2 000 minutes offertes par mois.
  - Gemini : 1 à 3 requêtes « Flash » et 1 à 3 requêtes de voix par épisode. Chaque modèle a son propre quota (souvent 10 à 20 par jour) : quand l'un est épuisé, le suivant prend le relais. La liste des modèles se met à jour toute seule au début de chaque épisode, d'après ceux que Google ouvre à ta clé. Limite : 6 épisodes ou mini-podcasts à la demande par jour, pour garder celui du matin. Les quotas repartent chaque jour à 9 h (heure suisse).
  - Tavily : 1 crédit par recherche, 1 000 par mois ; le bot limite les recherches à 15 par jour.
  - Cloudflare : le bot reste très loin des limites gratuites.
- **Confidentialité.**
  - Tes clés et ton lien d'agenda ne sont que dans les secrets GitHub et Cloudflare : jamais dans le dépôt, les journaux ni les messages à Gemini.
  - Pour écrire l'épisode, Google reçoit le titre, l'heure et le lieu de tes rendez-vous (et les notes, sauf si tu les désactives dans 🗓️ Agenda) ; Tavily reçoit les recherches de tes rubriques. Depuis la Suisse, Google n'utilise pas ces contenus pour améliorer ses produits, et le script lui demande de ne pas conserver les requêtes.
  - Le bot ignore toute autre personne que toi.
- **Conditions d'utilisation.** Google destine officiellement l'API aux développeurs ; pour un usage personnel comme celui-ci, c'est une zone grise.
- **Idées de sortie.** Prix et horaires viennent des sites trouvés ; quand ils manquent, c'est écrit « à vérifier ». Vérifie avant d'y aller.

## Dépannage

| Message ou souci | Que faire |
|---|---|
| ⏳ « raté pour l'instant, nouvel essai à … » | Rien : un rattrapage est prévu. Souvent une surcharge passagère de Gemini. |
| ⚠️ « Aucun modèle Gemini n'a répondu » | Surcharge ou quota du jour épuisé : vérifie [aistudio.google.com/rate-limit](https://aistudio.google.com/rate-limit). |
| « La clé Gemini est refusée » | Recopie le secret `GEMINI_API_KEY` (sans espace). |
| « agenda 1 inaccessible » | Le lien iCal a changé : recopie-le dans `CALENDAR_ICS_URL`. |
| « Recherche web : non configurée » | Ajoute le secret `TAVILY_API_KEY`. |
| Le bot ne répond plus | Ouvre `https://podcast.TON-SOUS-DOMAINE.workers.dev/installer` dans ton navigateur. |
| *Déployer le bot* en orange | Il manque `CLOUDFLARE_API_TOKEN` ou `CLOUDFLARE_ACCOUNT_ID`. |

Le détail d'une exécution : onglet *Actions* → l'exécution → étape *Préparer et envoyer le podcast*.

---

## Pour les curieux

| Fichier | Rôle |
|---|---|
| `cloudflare/src/` | Le bot : état et planning (`etat.js`), menus (`ui.js`), compréhension des messages (`comprendre.js`), assistant (`assistant.js`), modèle de réglages et de rubriques (`config.js`) |
| `podcast.py` | Fabrication de l'épisode : agenda, actus, script, voix, envoi |
| `regles.py`, `sources.py` | Rubriques du jour et sources gratuites |
| `recherche.py` | Résultats de recherche, mini-podcast, extraits de voix |
| `horaire.py` | Filet de sécurité des déclenchements GitHub |
| `reglages.toml` | Partie technique : modèles Gemini, débit du MP3… |
| `memoire.json` | Débit réel de la voix, dernier épisode |
| `preferences.json` | Sauvegarde quotidienne des réglages du bot |

**Tests** (aucun service réel n'est appelé) : `python tests/test_podcast.py`, `python tests/test_regles.py`, et dans `cloudflare/` : `npm ci && npm test` (bot de bout en bout, avec de faux Telegram, Gemini et GitHub). Ils tournent aussi sur GitHub à chaque changement.

**Essai sans rien envoyer** :

```sh
pip install -r requirements.txt
GEMINI_API_KEY=ta_clé CALENDAR_ICS_URL=ton_lien python podcast.py --sans-envoi
```

Le MP3, le texte, les chapitres et la pochette sont écrits dans `sortie/`.
