// Transmet au bot (Cloudflare) les secrets rangés dans GitHub, au moment du
// déploiement : ainsi tout se saisit au même endroit, rien à taper chez Cloudflare.
// Seuls les secrets que le bot n'a pas encore sont envoyés, pour ne jamais
// remplacer une valeur réglée chez Cloudflare. Exception : BOT_GITHUB_TOKEN
// (nom propre à GitHub, donc choix explicite) devient le GITHUB_TOKEN du bot.
//   node secrets.mjs   (variables : CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
//                       TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GEMINI_API_KEY, BOT_GITHUB_TOKEN)
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SI_ABSENTS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "GEMINI_API_KEY"];

export function aTransmettre(existants, env) {
  const deja = new Set(existants || []);
  const sortie = {};
  for (const nom of SI_ABSENTS) {
    const valeur = String(env[nom] || "").trim();
    if (valeur && !deja.has(nom)) sortie[nom] = valeur;
  }
  const jeton = String(env.BOT_GITHUB_TOKEN || "").trim();
  if (jeton) sortie.GITHUB_TOKEN = jeton;
  return sortie;
}

// Noms des secrets déjà présents, d'après « wrangler secret list » (JSON).
export function nomsExistants(sortieWrangler) {
  const texte = String(sortieWrangler || "");
  const debut = texte.indexOf("[");
  if (debut < 0) return [];
  try {
    return JSON.parse(texte.slice(debut)).map((s) => s?.name).filter(Boolean);
  } catch {
    return [];
  }
}

function principal() {
  const env = { ...process.env };
  for (const nom of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) env[nom] = String(env[nom] || "").trim();
  const wrangler = (args, options = {}) => execFileSync("npx", ["wrangler", ...args], { env, encoding: "utf8", ...options });
  let existants;
  try {
    existants = nomsExistants(wrangler(["secret", "list", "--format", "json"], { stdio: ["ignore", "pipe", "inherit"] }));
  } catch {
    console.log("::warning::Liste des secrets du bot illisible : rien n'est transmis. Ajoute-les dans Cloudflare (docs/INSTALLATION.md).");
    return;
  }
  const envoi = aTransmettre(existants, process.env);
  const noms = Object.keys(envoi);
  if (!noms.length) {
    console.log(`Secrets du bot : rien à transmettre (déjà présents : ${existants.join(", ") || "aucun"}).`);
  } else {
    try {
      wrangler(["secret", "bulk"], { input: JSON.stringify(envoi), stdio: ["pipe", "inherit", "inherit"] });
      console.log(`Secrets transmis au bot : ${noms.join(", ")}.`);
    } catch {
      console.log(`::warning::Les secrets ${noms.join(", ")} n'ont pas pu être transmis au bot : ajoute-les dans Cloudflare (docs/INSTALLATION.md).`);
      return;
    }
  }
  console.log(avertissementManquants([...existants, ...noms]) || "Le bot a tout ce qu'il lui faut.");
}

// Le jeton GitHub est indispensable ; Telegram est facultatif, mais il lui faut ses deux secrets.
export function avertissementManquants(presents) {
  const a = new Set(presents);
  if (!a.has("GITHUB_TOKEN")) return "::warning::Il manque au bot le jeton GitHub : ajoute le secret GitHub BOT_GITHUB_TOKEN, puis relance « Déployer le bot ».";
  const telegram = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"].filter((n) => a.has(n));
  if (telegram.length === 1) {
    return `::warning::Telegram à moitié réglé : il manque ${telegram[0] === "TELEGRAM_BOT_TOKEN" ? "TELEGRAM_CHAT_ID" : "TELEGRAM_BOT_TOKEN"} (ou retire l'autre pour fonctionner sans Telegram).`;
  }
  return "";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) principal();
