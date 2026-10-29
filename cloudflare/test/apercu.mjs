// Aperçu local de l'application, pour la voir dans un navigateur pendant le
// développement : faux services, bot local (wrangler dev), réglages d'exemple.
//   node test/apercu.mjs [reglages.json]   puis ouvrir le lien affiché (il contient un code
//   de connexion : la page s'ouvre directement).
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const racine = fileURLToPath(new URL("..", import.meta.url));
const variables = {
  GEMINI_API: "http://127.0.0.1:8790/gemini", GITHUB_API: "http://127.0.0.1:8790/gh", FERIES_API: "http://127.0.0.1:8790/nager",
  TAVILY_API: "http://127.0.0.1:8790/tavily", SNCF_API: "http://127.0.0.1:8790/sncf",
  ACTUS_API: "http://127.0.0.1:8790/actus", GEOCODAGE_API: "http://127.0.0.1:8790/geo", METEO_API: "http://127.0.0.1:8790/meteo",
  TRANSPORT_API: "http://127.0.0.1:8790/cff", IRAIL_API: "http://127.0.0.1:8790/irail", WIKI_API: "http://127.0.0.1:8790/wiki",
  WIKIVOYAGE_API: "http://127.0.0.1:8790/wikivoyage", SITES_API: "http://127.0.0.1:8790/sites", MODELE: "auteur/modele", MODELE_BRUT: "http://127.0.0.1:8790/brut",
  MODE_TEST: "1", GITHUB_TOKEN: "gh-test", GEMINI_API_KEY: "gem-test", ADRESSE: "http://127.0.0.1:8799",
};
const fichierVars = join(racine, ".dev.vars");
writeFileSync(fichierVars, Object.entries(variables).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
const etat = mkdtempSync(join(tmpdir(), "apercu-podcast-"));
const sansProxy = { ...process.env, NO_PROXY: "*", no_proxy: "*", HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "" };
const enfants = [];
const lancer = (commande, args) => {
  const enfant = spawn(commande, args, { cwd: racine, env: sansProxy, stdio: "ignore" });
  enfants.push(enfant);
  return enfant;
};
const nettoyer = () => {
  for (const enfant of enfants) { try { enfant.kill("SIGTERM"); } catch { /* déjà arrêté */ } }
  rmSync(fichierVars, { force: true });
  rmSync(etat, { recursive: true, force: true });
};
process.on("SIGINT", () => { nettoyer(); process.exit(0); });
process.on("SIGTERM", () => { nettoyer(); process.exit(0); });

lancer(process.execPath, [join("test", "faux.mjs")]);
lancer(join(racine, "node_modules", ".bin", "wrangler"),
  ["dev", "--port", "8799", "--ip", "127.0.0.1", "--persist-to", etat, "--show-interactive-dev-session=false"]);
let pret = false;
for (let i = 0; i < 90 && !pret; i++) {
  await new Promise((ok) => setTimeout(ok, 1000));
  try { pret = (await (await fetch("http://127.0.0.1:8799/")).text()).includes("version"); } catch { /* pas encore */ }
}
if (!pret) { console.log("Le bot local n'a pas démarré."); nettoyer(); process.exit(1); }
await fetch("http://127.0.0.1:8799/test/horloge?iso=2026-10-20T18:00");
const fichier = process.argv[2];
if (fichier) {
  const lu = JSON.parse(readFileSync(fichier, "utf8"));
  await fetch("http://127.0.0.1:8799/test/etat", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config: lu.config || lu, etat: lu.etat }) });
}
const secret = createHash("sha256").update("podcast:gh-test").digest("hex").slice(0, 48);
const code = await (await fetch("http://127.0.0.1:8799/api/code-connexion", { headers: { "X-Podcast-Secret": secret } })).json();
console.log(`Aperçu prêt : http://127.0.0.1:8799/app#code=${code.code}`);
await new Promise(() => {});
