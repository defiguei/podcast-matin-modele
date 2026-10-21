// Lance les tests de bout en bout du bot : faux services (Telegram, Gemini,
// GitHub…), bot local (wrangler dev) avec une horloge simulée, puis les scénarios.
// Un second bot, sans aucun secret Telegram, tourne à côté (port 8798) pour les
// scénarios « sans Telegram » : même code, sa propre configuration et ses variables.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const racine = fileURLToPath(new URL("..", import.meta.url));
const variables = {
  TELEGRAM_API: "http://127.0.0.1:8790/tg", GEMINI_API: "http://127.0.0.1:8790/gemini",
  GITHUB_API: "http://127.0.0.1:8790/gh", NOMINATIM_API: "http://127.0.0.1:8790/nominatim", FERIES_API: "http://127.0.0.1:8790/nager", TAVILY_API: "http://127.0.0.1:8790/tavily", SNCF_API: "http://127.0.0.1:8790/sncf", MODELE: "auteur/modele", MODELE_BRUT: "http://127.0.0.1:8790/brut",
  MODE_TEST: "1", TELEGRAM_BOT_TOKEN: "123:TEST", TELEGRAM_CHAT_ID: "42", GITHUB_TOKEN: "gh-test",
  GEMINI_API_KEY: "gem-test", ADRESSE: "http://127.0.0.1:8799",
};
const ecrireVars = (chemin, vars) => writeFileSync(chemin, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
const fichierVars = join(racine, ".dev.vars");
ecrireVars(fichierVars, variables);
const etat = mkdtempSync(join(tmpdir(), "bot-podcast-"));

const dossierSans = join(racine, ".sans-telegram");
mkdirSync(dossierSans, { recursive: true });
writeFileSync(join(dossierSans, "wrangler.toml"), readFileSync(join(racine, "wrangler.toml"), "utf8").replace(/^main = "src\//m, 'main = "../src/'));
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ...sansTelegram } = { ...variables, ADRESSE: "http://127.0.0.1:8798" };
ecrireVars(join(dossierSans, ".dev.vars"), sansTelegram);
const etatSans = mkdtempSync(join(tmpdir(), "bot-sans-telegram-"));

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
  rmSync(dossierSans, { recursive: true, force: true });
  rmSync(etatSans, { recursive: true, force: true });
}
process.on("SIGINT", () => { nettoyer(); process.exit(130); });

const wrangler = join(racine, "node_modules", ".bin", "wrangler");
lancer(process.execPath, [join("test", "faux.mjs")]);
const bot = lancer(wrangler, ["dev", "--port", "8799", "--ip", "127.0.0.1", "--persist-to", etat, "--show-interactive-dev-session=false"]);
const botSans = lancer(wrangler, ["dev", "-c", join(dossierSans, "wrangler.toml"), "--port", "8798", "--ip", "127.0.0.1",
  "--inspector-port", "9230", "--persist-to", etatSans, "--show-interactive-dev-session=false"]);

const repond = async (port) => {
  try { return (await (await fetch(`http://127.0.0.1:${port}/`)).text()).includes("version"); } catch { return false; }
};
let pret = false;
for (let i = 0; i < 120 && !pret; i++) {
  await new Promise((ok) => setTimeout(ok, 1000));
  pret = (await repond(8799)) && (await repond(8798));
}
const annoter = (titre, texte) => { if (process.env.GITHUB_ACTIONS) console.log(`::error title=${titre}::${texte.slice(-3500).replace(/%/g, "%25").replace(/\r?\n/g, "%0A")}`); };
if (!pret) {
  console.log("Le bot local n'a pas démarré :\n" + bot.journal.slice(-3000) + "\n— bot sans Telegram :\n" + botSans.journal.slice(-2000));
  annoter("Bot local", `${bot.journal}\n${botSans.journal}`);
  nettoyer();
  process.exit(1);
}
const tests = spawn(process.execPath, [join("test", "tests.mjs")], { cwd: racine, env: sansProxy, stdio: "inherit" });
const code = await new Promise((ok) => tests.on("exit", ok));
if (code) {
  console.log("\nJournal du bot (fin) :\n" + bot.journal.slice(-4000) + "\n— bot sans Telegram :\n" + botSans.journal.slice(-2000));
  const utile = (journal) => journal.split("\n").filter((l) => !/\[wrangler:info\] (GET|POST)/.test(l)).join("\n");
  annoter("Journal du bot", `${utile(bot.journal)}\n— sans Telegram —\n${utile(botSans.journal)}`);
}
nettoyer();
process.exit(code ?? 1);
