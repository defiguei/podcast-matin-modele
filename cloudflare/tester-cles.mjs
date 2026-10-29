// Teste les clés rangées dans les secrets GitHub (le bot ne les voit pas) et renvoie le
// résultat au bot, qui l'affiche avec la clé (Réglages › Gemini, ou Réglages › Sources › Services). Lancé par le bouton
// « Tester » de l'application (workflow « Tester mes clés »), ou à la main.
// Même test que dans le bot (src/connexions.js) ; aucune clé n'est affichée ni envoyée.
//   node tester-cles.mjs   (variables : CLES = « tavily,sncf » (vide : toutes), BOT_URL,
//                           BOT_GITHUB_TOKEN, GEMINI_API_KEY, TAVILY_API_KEY, SNCF_API_KEY)
// Bibliothèque standard de Node seulement : rien à installer.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { CLES, testerCle, testerFlux, testerService, testerSite } from "./src/connexions.js";

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

// Des outils que le service refuse au bot (Google Actualités, souvent) : testés d'ici, comme le
// podcast les lit. OUTILS = [{ cle: "flux:…", url } | { cle: "service:actus", ville, pays, profil } | { cle: "site:…", domaine }].
export async function testerOutils(liste = []) {
  const resultats = {};
  for (const o of liste.slice(0, 10)) {
    const [type, id] = String(o?.cle || "").split(":");
    if (type === "flux" && /^https?:\/\//.test(o.url || "")) resultats[o.cle] = await testerFlux(o.url);
    else if (type === "service" && id) resultats[o.cle] = await testerService({}, id, { ville: o.ville || "", profil: o.profil || {}, pays: o.pays || "CH" });
    else if (type === "site" && o.domaine) resultats[o.cle] = await testerSite(o.domaine);
  }
  for (const r of Object.values(resultats)) delete r.bloque;
  return resultats;
}

async function principal() {
  const env = process.env;
  const demandees = String(env.CLES || "").split(/[,\s]+/).filter((n) => CLES[n]);
  let outils = [];
  try { outils = JSON.parse(env.OUTILS || "[]"); } catch { outils = []; }
  // Des outils seulement : pas de test des clés (CLES vide voudrait dire « toutes »).
  const resultats = outils.length && !demandees.length ? {} : await testerToutes(env, demandees);
  const resultatsOutils = Array.isArray(outils) && outils.length ? await testerOutils(outils) : {};
  const lignes = ["## 🔑 Test des clés", "", ...Object.entries(resultats).map(([nom, r]) => `- **${CLES[nom].nom}** ${r.ok ? "✅" : "❌"} ${r.message}`),
                  ...Object.entries(resultatsOutils).map(([cle, r]) => `- **${cle}** ${r.ok ? "✅" : "❌"} ${r.message}`)];
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
    for (const [type, contenu] of [["cles", resultats], ["outils", resultatsOutils]]) {
      if (!Object.keys(contenu).length) continue;
      const r = await fetch(`${adresse}/api/evenement`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Podcast-Secret": secret, "User-Agent": "podcast-matin-github" },
        body: JSON.stringify({ type, resultats: contenu }), signal: AbortSignal.timeout(20000) });
      if (!r.ok) console.log(`::warning::Le bot refuse le résultat (erreur ${r.status}) : relance « Mettre à jour » puis « Déployer le bot ».`);
    }
  } catch (erreur) {
    console.log(`::warning::Bot injoignable à ${adresse} (${erreur.message}).`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  process.exitCode = await principal();
}
