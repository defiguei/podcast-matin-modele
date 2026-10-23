# Prénoms, journées et fêtes : sources, biais et choix

État au 23 octobre 2026. Ce document explique d'où viennent les données de fêtes du podcast, ce qu'on
a trouvé de fragile dans chaque source, et pourquoi le podcast ne fait plus aucun appel réseau pour ça.

## En bref

Trois causes expliquaient que « la fête du prénom » et « les fêtes mondiales » marchaient mal :

1. **Le calendrier des saints avait mai et juin inversés** (0 accord sur 59 jours avant correction :
   le 24 juin annonçait Donatien, le 24 mai Jean-Baptiste), plus un « 31 juin » fantôme et quelques coquilles.
   Corrigé dans `donnees/saints.json`.
2. **Les saints ne sont pas des prénoms.** Le fichier donne en moyenne 2,5 saints par jour (« Ste-Adalsinde »,
   « St-Oswald de Worcester »), pas le prénom que tout le monde attend. Le podcast lit maintenant un
   calendrier traditionnel, un prénom par jour, et garde les saints en information.
3. **Les fêtes du jour dépendaient d'un appel à Wikipédia chaque matin** (rubrique « Ce jour-là »), dont le
   flux a des jours défectueux connus et ne distingue pas fête nationale, journée de l'ONU, fête religieuse
   et opération commerciale. Remplacé par des données de référence intégrées, sans réseau.

## Ce que le podcast lit maintenant

| Fichier | Contenu | Fabriqué par |
|---|---|---|
| `donnees/prenoms.json` | un prénom principal par jour, fête du jour, prénoms secondaires | `outils/construire_fetes.py` |
| `donnees/journees.json` | journées ONU et agences (134 lignes dont 5 semaines et 6 règles de dates mobiles), 219 fêtes nationales pour 199 pays ou régions, 45 usages de Suisse, France, Belgique et fêtes populaires | idem |
| `donnees/saints.json` | calendrier des saints (corrigé), information secondaire | à la main (voir plus bas) |

Les tables sources sont des fichiers texte, une ligne par entrée, dans `outils/fetes/` : `prenoms.txt`,
`onu.txt`, `nationales.txt`, `usages.txt`, et deux listes tierces servant à recouper (`ref_mfat.txt`,
`ref_wikipedia.txt`). Pour changer une date : modifier la table, lancer `python3 outils/construire_fetes.py`
(`--rapport` pour le détail), pousser. Un test (`tests/test_regles.py`, « 5 ter ») vérifie que les fichiers
fabriqués sont à jour et cohérents. Le module `fetes.py` les lit, et calcule les jours mobiles
(fête des mères, heure d'hiver, Pâques et ses dérivés, Black Friday).

## Prénoms

**Retenu : le calendrier traditionnel des prénoms** (celui de l'almanach des PTT, repris par les calendriers
muraux français, belges et suisses romands). Un prénom par jour, que le podcast annonce d'abord.

Particularités et biais :

- **À notre connaissance, il n'existe pas de calendrier officiel** en France, en Belgique ni en Suisse (aucune des
  sources consultées n'en cite). Chaque éditeur (almanachs, sites, calendriers des postes) arbitre pour son compte,
  d'où des jours où les sources divergent.
- **Ce n'est pas un calendrier strictement liturgique.** On y trouve des saints, des bienheureux et des
  prénoms plus modernes (Karine, Larissa, Habib…) : pour 124 jours sur 351, le prénom n'est pas parmi les saints du calendrier
  revu des saints (65 % d'accord seulement). Une partie des écarts vient du calendrier romain réformé en 1969, qui a
  déplacé ou supprimé des fêtes (par exemple Jean de la Croix le 14 décembre, là où l'almanach garde Odile).
- **Les écarts ne sont pas des décalages d'un ou deux jours** : on l'a mesuré (moins d'une dizaine de cas sur 124
  s'expliquent par un décalage de un à trois jours), ce sont de vraies différences de calendrier. Le podcast ne tente donc pas de les « réconcilier ».
- **Un prénom par jour est une simplification** : certains jours en ont deux ou trois selon les almanachs
  (29 septembre : Michel, Gabriel, Raphaël). Les prénoms secondaires viennent du calendrier des saints.
- 15 jours sont des fêtes religieuses sans prénom fixe (Toussaint, Noël, Assomption…) : le podcast le dit.

Sources écartées :

- **`fetedujour.fr/api`** : gratuite, formats JSON, XML, texte, HTML, prénom ou saints ; mais seules les adresses IP
  fixes sont acceptées (incompatible avec les exécutions GitHub, dont l'adresse change) et le site demande
  d'enregistrer le résultat plutôt que de rappeler l'API. Inutile une fois les 366 jours constitués.
- **`nameday.abalin.net`** (API ouverte multi-pays) : documentation illisible depuis ici, couverture de la
  France, de la Suisse et de la Belgique non vérifiée.
- **Calendriers officiels d'autres pays** : la Finlande a le sien (Almanach de l'université d'Helsinki),
  mais ses données sont protégées par le droit d'auteur, avec redevance annuelle et mention obligatoire de la source.
  Aucune raison de s'en servir pour un auditeur de Suisse romande, de France ou de Belgique.
- **Fichier data.gouv.fr « Les saints et fêtes du calendrier »** : conservé comme source secondaire (Licence
  Ouverte), mais publié par un contributeur (« UnExtraterrestres Delespace »), sans documentation des fichiers (le portail l'indique lui-même), sans
  mention de prénoms, et avec les défauts corrigés ci-dessus. On ne l'utilise jamais seul.

## Journées internationales

**Retenu : les journées reconnues par l'ONU et ses agences** (UNESCO, OMS, FAO, OIT, UIT…), plus quelques
organisations (Francophonie, Union européenne). L'ONU ne liste qu'un mois par page ; le contrôle d'octobre 2026
a été fait contre cette page : ses 23 lignes sont toutes dans la table (la date mobile de la journée de l'habitat
(premier lundi) et des oiseaux migrateurs (deuxième samedi) tombent bien sur les 5 et 10 octobre 2026).

Particularités et biais :

- **« Officielle » veut dire peu de choses de plus de 600 journées** : selon l'enquête d'UFC-Que Choisir,
  moins de 200 sur plus de 600 ont une base officielle, dont environ 140 portées par l'ONU. Les autres sont
  créées par des associations, des fédérations professionnelles ou des entreprises, parfois pour vendre
  (journée du rangement de bureau lancée par un cabinet de conseil, par exemple). Il n'existe pas de liste
  officielle de référence : la légitimité d'une journée ne tient qu'à sa notoriété.
- **Le podcast distingue donc deux familles** : « officielles » (ONU et agences, annoncées comme telles) et « non
  officielles » (Journée mondiale du câlin, Star Wars Day, Towel Day, Black Friday… présentées comme telles).
- **23 journées sont marquées « sujet sensible »** (violences, deuil, suicide, torture, terrorisme…) : le podcast
  les annonce avec tact, sans plaisanterie.
- Certaines dates sont mobiles (premier lundi d'octobre pour l'habitat, troisième dimanche de novembre pour les
  victimes de la route) : le code les calcule chaque année.

Source écartée : **le flux « Ce jour-là » de Wikipédia** (catégorie *holidays*). Il mélange fêtes nationales,
religieuses et journées de l'ONU sans les distinguer, et plusieurs jours sont signalés comme défectueux dans le
suivi de la Wikimedia Foundation (cas documentés pour le suédois ; le français n'a pas pu être testé d'ici).

## Fêtes nationales

**Retenu : une table de 219 dates**, recoupée avec deux listes indépendantes : celle du ministère néo-zélandais
des Affaires étrangères (liste de diplomates, une date par pays) et la liste Wikipédia des « jours de
l'indépendance » (une indépendance n'est pas toujours une fête nationale).

Résultat du recoupement (calculé par `outils/construire_fetes.py --rapport`) : **88 dates confirmées par les deux
listes, 118 par une seule, 13 par aucune** (Japon, Éthiopie 28 mai, Grèce 28 octobre, Yémen, Québec, Saint-Marin, Andorre,
Taïwan, Bhoutan, Danemark, Écosse, Pays de Galles, Népal : dates connues, non retrouvées dans les deux listes).

Ce qu'on a trouvé de fragile d'un pays à l'autre :

- **Indépendance ≠ fête nationale.** Suisse (1er août, alliance de 1291), Belgique (21 juillet, serment du roi
  Léopold Ier), Norvège (17 mai, Constitution), Suède (6 juin), France (14 juillet), Italie (2 juin, République, alors que
  Wikipédia donne 17 mars, l'unité), Allemagne (3 octobre, réunification)… Une liste d'indépendances donne souvent
  la mauvaise date pour « la fête nationale ».
- **Plusieurs dates pour un pays** : Grèce (25 mars et « Ohi » 28 octobre), Bangladesh (26 mars et 16 décembre), Cuba,
  Pakistan, Malaisie (31 août et 16 septembre), Seychelles, Slovaquie, Monténégro, Arménie, Azerbaïdjan…
  Quand deux dates coexistent, les deux sont dans la table.
- **Pas de fête nationale officielle** : Danemark (le 5 juin, Jour de la Constitution, n'est pas férié) et
  Royaume-Uni (chaque nation a sa fête de saint : Saint-Georges, Saint-André, Saint-David). La date de naissance du roi, que la liste
  néo-zélandaise donnait pour le Danemark, est périmée (abdication de la reine Margrethe II en 2024).
- **Date liée à un régime** : Libye (la liste néo-zélandaise donne le 1er septembre, jour du coup d'État de 1969 ; Wikipédia
  retient l'indépendance du 24 décembre 1951), Irak, Syrie (régime changé en décembre 2024), Népal (la liste néo-zélandaise donne le 7 juillet
  sans explication), Afghanistan (depuis 2021, les autorités mettent en avant le 15 août). Ces entrées sont marquées « contestées »
  (drapeau C), annoncées avec leur note, et sont les premières à relire.
- **Statut politique contesté** : Kosovo, Palestine, Taïwan, Somaliland (non repris), Vatican (la liste néo-zélandaise donne
  l'anniversaire de l'élection du pape régnant, donc une date qui change avec chaque pontificat : 13 mars du temps de François).
  Le podcast n'affirme rien sur le statut, il annonce la date avec la réserve.
- **Date effective ≠ date célébrée** : Brunéi (indépendance 1er janvier 1984, fête le 23 février), Koweït (indépendance le 19 juin 1961, fête le
  25 février), Cameroun (la fête du 20 mai date de 1972, pas de l'indépendance de 1960), Équateur (premier cri de 1809,
  indépendance effective en 1822).
- **Contestée dans le pays même** : Australie (26 janvier, « jour de l'invasion » pour de nombreux Aborigènes), Bosnie-Herzégovine
  (1er mars non célébré en Republika Srpska).
- **Désaccords entre les deux listes** : Tonga (4 novembre selon la liste néo-zélandaise, 4 juin selon Wikipédia), Éthiopie (2 mars
  ou 28 mai), Malte (21 septembre, mais la liste néo-zélandaise ajoute le 22), Guyana (26 mai ou 23 février, deux fêtes distinctes).
- **Calendriers non grégoriens** : Israël (5 iyar) et Maldives (1er rabi' al-awwal) ne se mettent pas dans une table à dates fixes :
  non repris pour Israël, la fête de l'indépendance des Maldives retenue est celle du 26 juillet.
- **Les fêtes nationales dans le monde sont mélangées par le jour** : le podcast met le pays de l'auditeur en premier
  (1er août : la Suisse avant le Bénin) et ne cite pas tout s'il y en a beaucoup (cinq pays d'Amérique centrale le 15 septembre).

## Usages de Suisse, de France et de Belgique

45 entrées dans `outils/fetes/usages.txt` : ce qui change d'un pays à l'autre et ne se déduit pas d'une liste mondiale.

- **Fête des mères** : dernier dimanche de mai en France (sauf Pentecôte, alors premier dimanche de juin), deuxième dimanche de mai en
  Belgique et en Suisse. **Fête des pères** : troisième dimanche de juin (France), deuxième (Belgique), premier (Suisse).
- **Suisse** : Jeûne fédéral (troisième dimanche de septembre), Jeûne genevois, Escalade. **Belgique** : fêtes de la Communauté flamande
  (11 juillet), de la Communauté française (27 septembre), de la Wallonie, de Bruxelles-Capitale (8 mai), de la Dynastie (15 novembre).
  **France** : appel du 18 juin, journée du souvenir de la Déportation.
- **Heure d'été et d'hiver** : même règle dans les trois pays (derniers dimanches de mars et d'octobre).
- **Fête du Travail** : fériée en France et en Belgique, seulement dans certains cantons en Suisse.
- **Fêtes populaires** (marquées « non officielles ») : câlin, Pi, Star Wars Day, Towel Day, emojis, bière, pirates, Mole Day, Black Friday.

Les jours fériés légaux restent lus par la source « Jours fériés » (`pays.py`, bibliothèque `holidays`).

## Limites connues

- Les fêtes lunaires ou hébraïques (Aïd, Ramadan, Yom Kippour, Diwali) ne sont pas dans les tables : leur date change chaque année.
- Aucune fête cantonale ou régionale hors celles de Belgique et de Genève.
- Les 13 dates « non recoupées » et les 22 dates « contestées » méritent une relecture par un humain de temps en temps.
  Un changement de régime ou de loi modifie une fête nationale : à revoir chaque année en consultant le rapport.
- Je n'ai pas pu interroger directement Wikipédia ni l'API de fetedujour.fr depuis l'environnement de travail
  (accès web restreint) : le calendrier traditionnel a été saisi puis **recoupé avec le fichier des saints**, pas avec le site de
  l'almanach. Les 124 désaccords listés par `--rapport` sont la meilleure piste de relecture.

## Sources consultées

- ONU, [Journées et semaines internationales](https://www.un.org/en/observances/international-days-and-weeks) (octobre 2026).
- UFC-Que Choisir, [Journées mondiales : entre grandes causes et opérations marketing](https://www.quechoisir.org/actualite-journees-mondiales-entre-grandes-causes-et-operations-marketing-n177586/).
- Ministère néo-zélandais des Affaires étrangères, [National days](https://www.mfat.govt.nz/fr/embassies/national-days).
- Wikipédia, [List of national independence days](https://en.wikipedia.org/wiki/List_of_national_independence_days) et [National day](https://en.wikipedia.org/wiki/National_day).
- data.gouv.fr, [Les saints et fêtes du calendrier](https://www.data.gouv.fr/datasets/les-saints-et-fetes-du-calendrier/informations).
- [fetedujour.fr, API](https://fetedujour.fr/api/) ; [nameday.abalin.net](https://nameday.abalin.net) ; [Nager.Date](https://github.com/tinohager/Nager.Date) (jours fériés).
- Université d'Helsinki, [interface des jours de fête](https://almanakka.helsinki.fi/en/name-days/name-day-interface).
- Wikimedia, [service feed « On this day »](https://github.com/wikimedia/mediawiki-services-wikifeeds) et [suivi du défaut des jours fériés](https://phabricator.wikimedia.org/T158783).
- Wikipédia, [Calendrier romain général de 1969](https://en.wikipedia.org/wiki/General_Roman_Calendar_of_1969).

## Précisions ajoutées le 23 octobre 2026

- **Prénoms et saints.** La rubrique « Fête du prénom » ne cite plus les saints : elle donne le prénom du calendrier traditionnel et
  les autres prénoms que l'on fête souvent ce jour-là. Le calendrier des saints sert seulement de contrôle (accord de 65 %).
  Aucune source consultée ne distingue la France, la Belgique et la Suisse romande ; la tradition de la fête du prénom est moins
  suivie en Suisse alémanique, où nous n'avons pas de calendrier de référence.
- **La liste du ministère néo-zélandais.** C'est le ministère des Affaires étrangères de Nouvelle-Zélande qui publie les fêtes
  nationales des pays avec lesquels il a des relations : elle sert de seconde source indépendante de Wikipédia, pour presque tous les
  pays. La Nouvelle-Zélande elle-même y figure (Waitangi Day, 6 février).
- **Profils des pays.** `donnees/pays.json` est fabriqué par `outils/construire_pays.py` : noms français et langues officielles (CLDR),
  devise (CLDR), fuseau principal (base des fuseaux horaires). Les flux d'actualités des pays hors Suisse, France et Belgique sont des
  éditions locales de Google Actualités construites à partir du code du pays et de sa langue : elles n'ont pas pu être testées d'ici
  (réseau fermé) et certaines combinaisons pays/langue peuvent ne renvoyer aucun article. Les jours fériés viennent de la bibliothèque
  `holidays` (épisodes) et de Nager.Date (calendrier de l'application, environ 120 pays).
