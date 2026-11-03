// Ce qu'il faut chez Cloudflare pour mettre le bot en ligne, trouvé à partir du
// seul jeton d'API (secret GitHub CLOUDFLARE_API_TOKEN) :
//   - le compte : le secret CLOUDFLARE_ACCOUNT_ID s'il existe, sinon le seul compte du jeton ;
//   - le sous-domaine workers.dev du compte, créé s'il n'y en a pas encore ;
//   - l'adresse du bot : https://<nom du Worker>.<sous-domaine>.workers.dev
//     (la variable GitHub BOT_URL, si tu l'as réglée, passe avant).
//
//   node compte.mjs   (variables : CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID facultatif,
//                      ADRESSE_VARIABLE = vars.BOT_URL, GITHUB_REPOSITORY_OWNER)
// Écrit « compte=… » et « adresse=… » dans GITHUB_OUTPUT. Node seul, sans dépendance.
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Marque de l'adresse d'un dépôt pas encore personnalisé (écrite en morceaux :
// la mise à jour ne remplace que la forme entière).
const MARQUE = "TON-" + "SOUS-DOMAINE";

const api = () => String(process.env.CLOUDFLARE_API || "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");

export function nomDuWorker(toml) {
  return /^name\s*=\s*"([^"]+)"/m.exec(String(toml || ""))?.[1] || "podcast";
}

// L'adresse déjà inscrite dans le dépôt (après la première installation), sinon "".
export function adresseDesFichiers(toml) {
  const adresse = /^ADRESSE\s*=\s*"(https:\/\/[^"]+)"/m.exec(String(toml || ""))?.[1] || "";
  return adresse && !adresse.includes(MARQUE) ? adresse.replace(/\/+$/, "") : "";
}

export function choisirCompte(comptes, impose) {
  if (impose) return { id: impose };
  const liste = (comptes || []).filter((c) => c?.id);
  if (liste.length === 1) return { id: liste[0].id, nom: liste[0].name || "" };
  if (!liste.length) return { erreur: "Le jeton Cloudflare ne donne accès à aucun compte : recrée-le avec le lien de docs/INSTALLATION.md, puis remplace le secret CLOUDFLARE_API_TOKEN." };
  return { erreur: `Le jeton Cloudflare donne accès à ${liste.length} comptes (${liste.map((c) => c.name || c.id).join(", ")}) : ajoute le secret GitHub CLOUDFLARE_ACCOUNT_ID (l'Account ID du compte à utiliser, dans Workers & Pages), puis relance ce workflow.` };
}

// Noms à essayer pour le sous-domaine (il est unique chez Cloudflare) : le nom GitHub d'abord.
export function candidatsSousDomaine(proprietaire, alea = () => Math.random().toString(36).slice(2, 6)) {
  const base = String(proprietaire || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  const noms = base ? [base, `${base}-podcast`, `${base}-${alea()}`, `podcast-${alea()}`] : [`podcast-${alea()}`, `podcast-${alea()}`];
  return [...new Set(noms)];
}

export const adresseDuBot = (worker, sousDomaine) => `https://${worker}.${sousDomaine}.workers.dev`;

async function appeler(jeton, chemin, options = {}) {
  try {
    const r = await fetch(`${api()}${chemin}`, { ...options, headers: { Authorization: `Bearer ${jeton}`, "Content-Type": "application/json" } });
    const corps = await r.json().catch(() => ({}));
    return { statut: r.status, ok: r.ok && corps.success !== false, corps };
  } catch (erreur) {
    return { statut: 0, ok: false, corps: { errors: [{ message: erreur.message }] } };
  }
}

const erreurs = (r) => (r.corps?.errors || []).map((e) => e?.message).filter(Boolean).join(" ; ") || `réponse ${r.statut}`;

// Le sous-domaine workers.dev du compte, créé au besoin. Renvoie { sousDomaine, cree } ou { erreur }.
export async function sousDomaine(jeton, compte, proprietaire, alea) {
  const lu = await appeler(jeton, `/accounts/${compte}/workers/subdomain`);
  if (lu.ok && lu.corps?.result?.subdomain) return { sousDomaine: lu.corps.result.subdomain, cree: false };
  if (lu.statut === 401 || lu.statut === 403) return { erreur: `Cloudflare refuse le jeton (${erreurs(lu)}) : il lui faut la permission « Workers Scripts : Edit ».` };
  let derniere = lu;
  for (const nom of candidatsSousDomaine(proprietaire, alea)) {
    const cree = await appeler(jeton, `/accounts/${compte}/workers/subdomain`, { method: "PUT", body: JSON.stringify({ subdomain: nom }) });
    if (cree.ok) return { sousDomaine: cree.corps?.result?.subdomain || nom, cree: true };
    derniere = cree;
    if (cree.statut === 401 || cree.statut === 403) break;
  }
  return { erreur: `Impossible de créer ton sous-domaine workers.dev (${erreurs(derniere)}). Ouvre une fois Workers & Pages dans le tableau de bord Cloudflare, choisis-y un sous-domaine, puis relance ce workflow.` };
}

// Tout le travail : { compte, adresse, notes } ou { erreur }.
export async function trouver(env, toml) {
  const jeton = String(env.CLOUDFLARE_API_TOKEN || "").trim();
  const impose = String(env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  const notes = [];
  let comptes = [];
  if (!impose) {
    const r = await appeler(jeton, "/accounts?per_page=50");
    if (!r.ok) return { erreur: `Cloudflare refuse le jeton (${erreurs(r)}) : vérifie le secret CLOUDFLARE_API_TOKEN (un seul jeton, sur une ligne).` };
    comptes = r.corps?.result || [];
  }
  const compte = choisirCompte(comptes, impose);
  if (compte.erreur) return compte;
  if (compte.nom) notes.push(`Compte Cloudflare : ${compte.nom}.`);
  const variable = String(env.ADRESSE_VARIABLE || "").trim().replace(/\/+$/, "");
  if (/^https:\/\//.test(variable)) return { compte: compte.id, adresse: variable, notes: [...notes, "Adresse du bot : variable GitHub BOT_URL."] };
  const sd = await sousDomaine(jeton, compte.id, env.GITHUB_REPOSITORY_OWNER);
  if (sd.erreur) {
    const deja = adresseDesFichiers(toml);
    if (deja) return { compte: compte.id, adresse: deja, notes: [...notes, `::warning::Sous-domaine illisible (${sd.erreur}) : adresse déjà inscrite dans le dépôt gardée.`] };
    return { erreur: sd.erreur };
  }
  if (sd.cree) notes.push(`Sous-domaine workers.dev créé : ${sd.sousDomaine}.`);
  return { compte: compte.id, adresse: adresseDuBot(nomDuWorker(toml), sd.sousDomaine), notes };
}

async function principal() {
  const toml = readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");
  const resultat = await trouver(process.env, toml);
  if (resultat.erreur) {
    console.log(`::error title=Cloudflare::${resultat.erreur}`);
    process.exit(1);
  }
  for (const note of resultat.notes) console.log(note);
  console.log(`Adresse du bot : ${resultat.adresse}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `compte=${resultat.compte}\nadresse=${resultat.adresse}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) principal();
