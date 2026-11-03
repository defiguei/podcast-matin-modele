// Page d'installation du Podcast du matin (servie par GitHub Pages depuis le modèle).
// Elle remplace les réglages à la main de docs/INSTALLATION.md : la personne crée sa copie
// et deux jetons (liens pré-remplis), la page range les secrets dans son dépôt (chiffrés,
// par l'API de GitHub), lance « Déployer le bot », suit l'exécution, lit l'adresse du bot
// inscrite dans le dépôt et lui demande le premier code de connexion.
// Les jetons ne quittent ce navigateur que vers GitHub (et le secret partagé vers le bot) ;
// rien n'est gardé : recharger la page oublie tout.
import { sceller, qrSvg } from "./outils.js";

const GITHUB = "https://api.github.com";
const MODELE_PAR_DEFAUT = { proprietaire: "defiguei", nom: "podcast-matin-modele" };
const NOM_COPIE = "podcast-matin";
// Adresse d'un dépôt pas encore personnalisé (écrite en morceaux : la mise à jour ne remplace que la forme entière).
const MARQUE = "TON-" + "SOUS-DOMAINE";

// ───────────────────────────── liens pré-remplis ─────────────────────────────

// Le modèle d'où vient cette page (GitHub Pages : <propriétaire>.github.io/<dépôt>/installer/).
export function modeleDeLaPage(lieu) {
  const hote = String(lieu?.hostname || "");
  const dossier = String(lieu?.pathname || "").split("/").filter(Boolean)[0];
  return hote.endsWith(".github.io") && dossier ? { proprietaire: hote.split(".")[0], nom: dossier } : MODELE_PAR_DEFAUT;
}

export function lienCopie(modele = MODELE_PAR_DEFAUT) {
  const p = new URLSearchParams({ template_owner: modele.proprietaire, template_name: modele.nom, owner: "@me",
    name: NOM_COPIE, visibility: "private", description: "Mon podcast du matin" });
  return `https://github.com/new?${p}`;
}

// Jeton du bot : lancer les épisodes (Actions), installer les mises à jour (Contents, Workflows),
// et, pour cette page, ranger les secrets (Secrets). Reste à choisir le dépôt.
export function lienJetonGitHub() {
  const p = new URLSearchParams({ name: "Podcast du matin", description: "Jeton du bot de mon podcast du matin : épisodes, mises à jour, secrets.",
    expires_in: "none", actions: "write", contents: "write", workflows: "write", secrets: "write" });
  return `https://github.com/settings/personal-access-tokens/new?${p}`;
}

// Jeton Cloudflare : mettre le bot en ligne (Workers Scripts) et trouver le compte (Account Settings).
export function lienJetonCloudflare() {
  const permissions = [{ key: "workers_scripts", type: "edit" }, { key: "account_settings", type: "read" }];
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(JSON.stringify(permissions))}`
    + `&accountId=*&zoneId=all&name=${encodeURIComponent("Podcast du matin")}`;
}

// ─────────────────────────────── outils ───────────────────────────────

export class ErreurInstallation extends Error {
  constructor(message, lien = "") { super(message); this.lien = lien; }
}

export const nettoyer = (valeur) => String(valeur || "").replace(/^\s+|\s+$/g, "");

export function adresseDuToml(texte) {
  const adresse = /^ADRESSE\s*=\s*"(https:\/\/[^"]+)"/m.exec(String(texte || ""))?.[1] || "";
  return adresse && !adresse.includes(MARQUE) ? adresse.replace(/\/+$/, "") : "";
}

// Secret partagé entre GitHub et le bot (comme liaison.secret_partage) : sha256("podcast:" + jeton), 48 caractères.
export async function secretPartage(jeton) {
  const empreinte = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`podcast:${jeton}`));
  return [...new Uint8Array(empreinte)].map((o) => o.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

const texteBase64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(String(b64 || "").replace(/\s+/g, "")), (c) => c.charCodeAt(0)));

async function gh(contexte, chemin, options = {}) {
  const entetes = { Authorization: `Bearer ${contexte.jeton}`, Accept: "application/vnd.github+json" };
  if (options.corps !== undefined) entetes["Content-Type"] = "application/json";
  let r;
  try {
    r = await contexte.fetch(`${contexte.api || GITHUB}${chemin}`, { method: options.methode || "GET", headers: entetes,
      body: options.corps !== undefined ? JSON.stringify(options.corps) : undefined });
  } catch {
    throw new ErreurInstallation("GitHub ne répond pas : vérifie ta connexion, puis réessaie.");
  }
  let corps = null;
  try { corps = await r.json(); } catch { /* réponse vide (204) */ }
  return { statut: r.status, ok: r.ok, corps };
}

// ───────────────────────────── vérifications ─────────────────────────────

// Le jeton GitHub ouvre-t-il bien la copie, avec ce qu'il faut ? Renvoie { depot, cle } ou lève une erreur claire.
export async function verifierGitHub({ jeton, nomDepot = NOM_COPIE, fetch: f = (...a) => globalThis.fetch(...a), api }) {
  const contexte = { jeton: nettoyer(jeton), fetch: f, api };
  if (!contexte.jeton) throw new ErreurInstallation("Colle d'abord ton jeton GitHub.");
  if (/\s/.test(contexte.jeton)) throw new ErreurInstallation("Le jeton contient un espace ou un retour à la ligne : recopie-le en entier, d'un seul morceau.");
  const moi = await gh(contexte, "/user");
  if (moi.statut === 401) throw new ErreurInstallation("GitHub refuse ce jeton : recopie-le en entier (il commence par github_pat_), ou crée-en un nouveau.");
  if (!moi.ok || !moi.corps?.login) throw new ErreurInstallation(`GitHub répond ${moi.statut} : réessaie dans un instant.`);
  const nom = nettoyer(nomDepot) || NOM_COPIE;
  const depot = nom.includes("/") ? nom : `${moi.corps.login}/${nom}`;
  const lu = await gh(contexte, `/repos/${depot}`);
  if (lu.statut === 404 || lu.statut === 403) {
    throw new ErreurInstallation(`Ce jeton n'ouvre pas le dépôt ${depot}. En le créant, dans « Repository access », choisis « Only select repositories » puis ${nom.split("/").pop()} (et vérifie que ta copie existe bien, étape 1).`);
  }
  if (!lu.ok) throw new ErreurInstallation(`GitHub répond ${lu.statut} : réessaie dans un instant.`);
  if (!lu.corps?.private) throw new ErreurInstallation(`Ton dépôt ${depot} est public : passe-le en privé (Settings › General › Danger Zone › Change visibility), puis réessaie. Il contiendra ton code de connexion.`);
  const deploiement = await gh(contexte, `/repos/${depot}/contents/.github/workflows/deployer-bot.yml`);
  if (deploiement.statut === 404) throw new ErreurInstallation(`${depot} n'est pas une copie du podcast : crée-la avec le bouton de l'étape 1.`);
  if (deploiement.statut === 403) throw new ErreurInstallation("Il manque au jeton la permission « Contents » (Read and write) : crée un nouveau jeton avec le lien de l'étape 2.");
  const actions = await gh(contexte, `/repos/${depot}/actions/workflows`);
  if (actions.statut === 403) throw new ErreurInstallation("Il manque au jeton la permission « Actions » (Read and write) : crée un nouveau jeton avec le lien de l'étape 2.");
  const cle = await gh(contexte, `/repos/${depot}/actions/secrets/public-key`);
  if (cle.statut === 403) throw new ErreurInstallation("Il manque au jeton la permission « Secrets » (Read and write) : crée un nouveau jeton avec le lien de l'étape 2.");
  if (!cle.ok || !cle.corps?.key) throw new ErreurInstallation(`GitHub répond ${cle.statut} : réessaie dans un instant.`);
  return { depot, cle: { id: cle.corps.key_id, valeur: cle.corps.key } };
}

export function verifierCloudflare(jeton) {
  const valeur = nettoyer(jeton);
  if (!valeur) throw new ErreurInstallation("Colle d'abord ton jeton Cloudflare.");
  if (/\s/.test(valeur)) throw new ErreurInstallation("Le jeton contient un espace ou un retour à la ligne : recopie-le en entier, d'un seul morceau.");
  if (valeur.length < 30) throw new ErreurInstallation("Ce jeton Cloudflare paraît incomplet : recopie-le en entier (Cloudflare ne le montre qu'une fois ; au besoin, crées-en un autre).");
  return valeur;
}

// ───────────────────────────── installation ─────────────────────────────

// Ce qu'il faut faire quand une étape du déploiement échoue.
const CONSEILS = [
  [/Cloudflare|compte/i, "Cloudflare a refusé le jeton : crée-en un nouveau avec le lien de l'étape 3 (la liste doit contenir « Workers Scripts : Edit »)."],
  [/Mettre en ligne/i, "Cloudflare a refusé la mise en ligne. Si Cloudflare t'a demandé de confirmer ton adresse e-mail, fais-le, puis réessaie."],
  [/Inscrire/i, "Le jeton GitHub n'a pas pu écrire dans ton dépôt : il lui faut « Contents » et « Workflows » en Read and write (lien de l'étape 2)."],
  [/Tester/i, "Les tests du bot n'ont pas réussi : réessaie ; si ça recommence, signale-le à l'auteur du podcast."],
];

const conseil = (etape) => CONSEILS.find(([motif]) => motif.test(etape))?.[1] || "Ouvre l'exécution sur GitHub pour lire le message, puis réessaie.";

// options : { jetonGithub, jetonCloudflare, depot, cle, fetch, api, attendre, surEtape, maintenant }
// surEtape(cle, details) : « secrets », « lance », « deploiement » ({ etapes, lien }), « code ».
export async function installer(options) {
  const f = options.fetch || ((...a) => globalThis.fetch(...a));
  const attendre = options.attendre || ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  const maintenant = options.maintenant || (() => Date.now());
  const signaler = options.surEtape || (() => {});
  const contexte = { jeton: nettoyer(options.jetonGithub), fetch: f, api: options.api };
  const depot = options.depot;

  // 1. Les secrets, chiffrés pour le dépôt.
  for (const [nom, valeur] of [["BOT_GITHUB_TOKEN", contexte.jeton], ["CLOUDFLARE_API_TOKEN", nettoyer(options.jetonCloudflare)]]) {
    const r = await gh(contexte, `/repos/${depot}/actions/secrets/${nom}`, { methode: "PUT",
      corps: { encrypted_value: sceller(valeur, options.cle.valeur), key_id: options.cle.id } });
    if (!r.ok) throw new ErreurInstallation(r.statut === 403
      ? "Il manque au jeton GitHub la permission « Secrets » (Read and write) : crée un nouveau jeton avec le lien de l'étape 2."
      : `GitHub n'a pas rangé le secret ${nom} (réponse ${r.statut}) : réessaie.`);
  }
  signaler("secrets");

  // 2. « Déployer le bot ».
  const depart = maintenant();
  const lance = await gh(contexte, `/repos/${depot}/actions/workflows/deployer-bot.yml/dispatches`, { methode: "POST", corps: { ref: "main" } });
  if (!lance.ok) throw new ErreurInstallation(lance.statut === 403
    ? "Il manque au jeton GitHub la permission « Actions » (Read and write) : crée un nouveau jeton avec le lien de l'étape 2."
    : `GitHub n'a pas lancé le déploiement (réponse ${lance.statut}). Ouvre l'onglet Actions de ton dépôt : s'il demande d'activer les workflows, accepte, puis réessaie.`,
    `https://github.com/${depot}/actions`);
  let execution = null;
  for (let essai = 0; essai < 30 && !execution; essai++) {
    await attendre(4000);
    const liste = await gh(contexte, `/repos/${depot}/actions/workflows/deployer-bot.yml/runs?event=workflow_dispatch&per_page=5`);
    execution = (liste.corps?.workflow_runs || []).find((r) => Date.parse(r.created_at) >= depart - 60000) || null;
  }
  if (!execution) throw new ErreurInstallation("Le déploiement ne démarre pas : ouvre l'onglet Actions de ton dépôt pour voir s'il attend quelque chose, puis réessaie.", `https://github.com/${depot}/actions`);
  signaler("lance", { lien: execution.html_url });

  // 3. On suit l'exécution jusqu'au bout (trois minutes environ, vingt au plus).
  let fini = null, etapes = [];
  for (let tour = 0; tour < 240 && !fini; tour++) {
    // L'état de l'exécution d'abord : une fois finie, ses étapes lues ensuite sont les dernières.
    const run = await gh(contexte, `/repos/${depot}/actions/runs/${execution.id}`);
    const travaux = await gh(contexte, `/repos/${depot}/actions/runs/${execution.id}/jobs`);
    const job = travaux.corps?.jobs?.[0];
    if (job) {
      etapes = (job.steps || []).filter((e) => !/^(Set up job|Post |Complete job)/.test(e.name))
        .map((e) => ({ nom: e.name, etat: e.status, issue: e.conclusion }));
      signaler("deploiement", { etapes, lien: execution.html_url });
    }
    if (run.corps?.status === "completed") { fini = run.corps; break; }
    await attendre(5000);
  }
  if (!fini) throw new ErreurInstallation("Le déploiement dure plus de vingt minutes : ouvre-le sur GitHub pour voir où il en est.", execution.html_url);
  if (fini.conclusion !== "success") {
    const ratee = etapes.find((e) => e.issue === "failure")?.nom || "";
    throw new ErreurInstallation(`Le déploiement s'est arrêté${ratee ? ` à l'étape « ${ratee} »` : ""}. ${conseil(ratee)}`, execution.html_url);
  }
  if (etapes.some((e) => /Mettre en ligne/.test(e.nom) && e.issue === "skipped")) {
    throw new ErreurInstallation("Le déploiement n'a pas trouvé le jeton Cloudflare : réessaie (étape 3).", execution.html_url);
  }

  // 4. L'adresse du bot, inscrite dans le dépôt par le déploiement.
  const toml = await gh(contexte, `/repos/${depot}/contents/cloudflare/wrangler.toml?ref=main`);
  const adresse = toml.ok ? adresseDuToml(texteBase64(toml.corps?.content)) : "";
  if (!adresse) throw new ErreurInstallation(`L'adresse du bot n'a pas été inscrite dans ton dépôt. ${conseil("Inscrire")}`, execution.html_url);

  // 5. Le premier code de connexion, demandé au bot.
  const secret = await secretPartage(contexte.jeton);
  let reponse = null;
  for (let essai = 0; essai < 6 && !reponse; essai++) {
    if (essai) await attendre(5000);
    try {
      const r = await f(`${adresse}/api/code-connexion?si=premiere`, { headers: { "X-Podcast-Secret": secret } });
      if (r.ok) reponse = await r.json();
    } catch { /* le bot démarre */ }
  }
  if (!reponse) throw new ErreurInstallation(`Ton bot est en ligne (${adresse}) mais ne donne pas de code : demande-en un dans l'onglet Actions de ton dépôt › Code de connexion › Run workflow (le code est dans le résumé).`, `https://github.com/${depot}/actions/workflows/code-connexion.yml`);
  const application = reponse.adresse || `${adresse}/app`;
  signaler("code");
  return { depot, adresse, application, code: reponse.code || null, jusqua: reponse.jusqua || "", lien: reponse.code ? `${application}#code=${reponse.code}` : application };
}

// ───────────────────────────── la page ─────────────────────────────

if (typeof document !== "undefined") demarrer();

function demarrer() {
  const $ = (id) => document.getElementById(id);
  const etat = { etape: 1, github: null, cloudflare: "" };
  const modele = modeleDeLaPage(location);

  $("lien-copie").href = lienCopie(modele);
  $("lien-jeton-github").href = lienJetonGitHub();
  $("lien-jeton-cloudflare").href = lienJetonCloudflare();
  $("lien-manuel").href = `https://github.com/${modele.proprietaire}/${modele.nom}/blob/main/docs/INSTALLATION.md`;
  $("lien-source").href = `https://github.com/${modele.proprietaire}/${modele.nom}/tree/main/docs/installer`;

  function montrer(n) {
    etat.etape = n;
    document.querySelectorAll(".etape").forEach((bloc) => {
      const numero = Number(bloc.dataset.etape);
      bloc.classList.toggle("ouverte", numero === n);
      bloc.classList.toggle("faite", numero < n);
      bloc.querySelector(".corps").hidden = numero !== n;
    });
    const ouverte = document.querySelector(`.etape[data-etape="${n}"]`);
    if (ouverte && n > 1) ouverte.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function erreur(id, message, lien) {
    const bloc = $(id);
    bloc.hidden = !message;
    bloc.innerHTML = "";
    if (!message) return;
    const p = document.createElement("p");
    p.textContent = message;
    bloc.append(p);
    if (lien) {
      const a = document.createElement("a");
      a.href = lien; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Voir sur GitHub ↗";
      bloc.append(a);
    }
  }

  function occupe(bouton, oui, texte) {
    bouton.disabled = oui;
    if (texte) bouton.textContent = texte;
  }

  $("copie-faite").addEventListener("click", () => montrer(2));

  $("verifier-github").addEventListener("click", async () => {
    const bouton = $("verifier-github");
    erreur("erreur-github", "");
    occupe(bouton, true, "Vérification…");
    try {
      etat.github = await verifierGitHub({ jeton: $("jeton-github").value, nomDepot: $("nom-depot").value });
      $("resume-github").textContent = etat.github.depot;
      montrer(3);
    } catch (e) {
      erreur("erreur-github", e.message, e.lien);
    } finally {
      occupe(bouton, false, "Vérifier et continuer");
    }
  });

  $("verifier-cloudflare").addEventListener("click", () => {
    erreur("erreur-cloudflare", "");
    try {
      etat.cloudflare = verifierCloudflare($("jeton-cloudflare").value);
      $("resume-cloudflare").textContent = "jeton prêt";
      montrer(4);
    } catch (e) {
      erreur("erreur-cloudflare", e.message);
    }
  });

  const LIGNES = { secrets: "Jetons rangés (chiffrés) dans ton dépôt", lance: "Déploiement lancé", code: "Code de connexion demandé à ton bot" };

  function ligne(texte, etatLigne) {
    const li = document.createElement("li");
    li.className = etatLigne;
    li.textContent = texte;
    return li;
  }

  $("installer").addEventListener("click", async () => {
    const bouton = $("installer");
    const suivi = $("suivi");
    erreur("erreur-installation", "");
    $("resultat").hidden = true;
    occupe(bouton, true, "Installation en cours…");
    suivi.hidden = false;
    suivi.innerHTML = "";
    const faites = new Set();
    let etapes = [];
    const redessiner = () => {
      suivi.innerHTML = "";
      suivi.append(ligne(LIGNES.secrets, faites.has("secrets") ? "ok" : "encours"));
      if (faites.has("secrets")) suivi.append(ligne(LIGNES.lance, faites.has("lance") ? "ok" : "encours"));
      for (const e of etapes) {
        suivi.append(ligne(e.nom, e.issue === "success" ? "ok" : e.issue === "failure" ? "rate" : e.issue === "skipped" ? "saute" : e.etat === "in_progress" ? "encours" : "attente"));
      }
      if (faites.has("code")) suivi.append(ligne(LIGNES.code, "ok"));
    };
    redessiner();
    try {
      const fin = await installer({ jetonGithub: $("jeton-github").value, jetonCloudflare: etat.cloudflare, depot: etat.github.depot, cle: etat.github.cle,
        surEtape: (cle, details) => { faites.add(cle); if (details?.etapes) etapes = details.etapes; redessiner(); } });
      afficherResultat(fin);
      occupe(bouton, false, "Réinstaller");
    } catch (e) {
      erreur("erreur-installation", e.message, e.lien);
      occupe(bouton, false, "Réessayer");
    }
  });

  function afficherResultat(fin) {
    const bloc = $("resultat");
    bloc.hidden = false;
    $("adresse-app").textContent = fin.application;
    $("adresse-app").href = fin.application;
    $("ouvrir-app").href = fin.lien;
    $("qr").innerHTML = qrSvg(fin.lien);
    $("code").textContent = fin.code ? fin.code.replace(/(\d{3})(\d{3})/, "$1 $2") : "";
    $("bloc-code").hidden = !fin.code;
    $("deja-connecte").hidden = Boolean(fin.code);
    $("jusqua").textContent = fin.jusqua ? `valable jusqu'à ${fin.jusqua.replace(":", " h ")}, une seule fois` : "valable une heure, une seule fois";
    bloc.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  montrer(1);
}
