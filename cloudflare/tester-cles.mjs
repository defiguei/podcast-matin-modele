// Teste les clés rangées dans les secrets GitHub (le bot ne les voit pas) et renvoie le
// résultat au bot, qui l'affiche avec la clé (Réglages › Gemini, ou Réglages › Sources › Services). Lancé par le bouton
// « Tester » de l'application (workflow « Tester mes clés »), ou à la main.
// Même test que dans le bot (src/connexions.js) ; aucune clé n'est affichée ni envoyée.
//   node tester-cles.mjs   (variables : CLES = « tavily,sncf » (vide : toutes), BOT_URL,
//                           BOT_GITHUB_TOKEN, GEMINI_API_KEY, TAVILY_API_KEY, SNCF_API_KEY)
// Bibliothèque standard de Node seulement : rien à installer.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { CLES, testerCle } from "./src/connexions.js";

export async function testerToutes(env, demandees = []) {
  const resultats = {};
  for (const [nom, def] of Object.entries(CLES)) {
    if (demandees.length && !demandees.includes(nom)) continue;
    const valeur = String(env[def.variable] || "").trim();
    resultats[nom] = valeur ? await testerCle(env, nom, valeur)
      : { ok: false, message: `Pas de secret GitHub ${def.variable} : colle la clé dans l'application, ou ajoute ce secret.` };
  }
  return resultats;
}

async function principal() {
  const env = process.env;
  const demandees = String(env.CLES || "").split(/[,\s]+/).filter((n) => CLES[n]);
  const resultats = await testerToutes(env, demandees);
  const lignes = ["## 🔑 Test des clés", "", ...Object.entries(resultats).map(([nom, r]) => `- **${CLES[nom].nom}** ${r.ok ? "✅" : "❌"} ${r.message}`)];
  console.log(lignes.join("\n"));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lignes.join("\n")}\n`);

  const adresse = String(env.BOT_URL || "").trim().replace(/\/+$/, "");
  const jeton = String(env.BOT_GITHUB_TOKEN || "").trim();
  if (!adresse || !jeton) {
    console.log("::warning::Résultat non transmis au bot : il faut la variable BOT_URL et le secret BOT_GITHUB_TOKEN.");
    return 0;
  }
  const secret = createHash("sha256").update(`podcast:${jeton}`).digest("hex").slice(0, 48);
  try {
    const r = await fetch(`${adresse}/api/evenement`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Podcast-Secret": secret, "User-Agent": "podcast-matin-github" },
      body: JSON.stringify({ type: "cles", resultats }), signal: AbortSignal.timeout(20000) });
    if (!r.ok) console.log(`::warning::Le bot refuse le résultat (erreur ${r.status}) : relance « Mettre à jour » puis « Déployer le bot ».`);
  } catch (erreur) {
    console.log(`::warning::Bot injoignable à ${adresse} (${erreur.message}).`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  process.exitCode = await principal();
}
