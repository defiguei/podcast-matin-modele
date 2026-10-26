// Lance les tests de bout en bout du bot : faux services (Gemini, GitHub…),
// bot local (wrangler dev) avec une horloge simulée, puis les scénarios.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const racine = fileURLToPath(new URL("..", import.meta.url));
const variables = {
  GEMINI_API: "http://127.0.0.1:8790/gemini", GITHUB_API: "http://127.0.0.1:8790/gh", FERIES_API: "http://127.0.0.1:8790/nager",
  TAVILY_API: "http://127.0.0.1:8790/tavily", SNCF_API: "http://127.0.0.1:8790/sncf", MODELE: "auteur/modele", MODELE_BRUT: "http://127.0.0.1:8790/brut",
  MODE_TEST: "1", GITHUB_TOKEN: "gh-test", GEMINI_API_KEY: "gem-test", ADRESSE: "http://127.0.0.1:8799",
};
const fichierVars = join(racine, ".dev.vars");
writeFileSync(fichierVars, Object.entries(variables).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
const etat = mkdtempSync(join(tmpdir(), "bot-podcast-"));

const sansProxy = { ...process.env, NO_PROXY: "*", no_proxy: "*", HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "" };

const enfants = [];
function lancer(commande, args, options = {}) {
  const enfant = spawn(commande, args, { cwd: racine, env: sansProxy, stdio: ["ignore", "pipe", "pipe"], ...options });
  enfant.journal = "";
  enfant.stdout.on("data", (d) => { enfant.journal += d; });
  enfant.stderr.on("data", (d) => { enfant.journal += d; });
  enfants.push(enfant);
  return enfant;
}

function nettoyer() {
  for (const enfant of enfants) { try { enfant.kill("SIGTERM"); } catch { /* déjà arrêté */ } }
  rmSync(fichierVars, { force: true });
  rmSync(etat, { recursive: true, force: true });
}
process.on("SIGINT", () => { nettoyer(); process.exit(130); });

const wrangler = join(racine, "node_modules", ".bin", "wrangler");
lancer(process.execPath, [join("test", "faux.mjs")]);
const bot = lancer(wrangler, ["dev", "--port", "8799", "--ip", "127.0.0.1", "--persist-to", etat, "--show-interactive-dev-session=false"]);

const repond = async (port) => {
  try { return (await (await fetch(`http://127.0.0.1:${port}/`)).text()).includes("version"); } catch { return false; }
};
let pret = false;
for (let i = 0; i < 120 && !pret; i++) {
  await new Promise((ok) => setTimeout(ok, 1000));
  pret = await repond(8799);
}
const annoter = (titre, texte) => { if (process.env.GITHUB_ACTIONS) console.log(`::error title=${titre}::${texte.slice(-3500).replace(/%/g, "%25").replace(/\r?\n/g, "%0A")}`); };
if (!pret) {
  console.log("Le bot local n'a pas démarré :\n" + bot.journal.slice(-3000));
  annoter("Bot local", bot.journal);
  nettoyer();
  process.exit(1);
}
const tests = spawn(process.execPath, [join("test", "tests.mjs")], { cwd: racine, env: sansProxy, stdio: "inherit" });
const code = await new Promise((ok) => tests.on("exit", ok));
if (code) {
  console.log("\nJournal du bot (fin) :\n" + bot.journal.slice(-4000));
  annoter("Journal du bot", bot.journal.split("\n").filter((l) => !/\[wrangler:info\] (GET|POST)/.test(l)).join("\n"));
}
nettoyer();
process.exit(code ?? 1);
