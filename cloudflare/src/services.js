// Accès aux services extérieurs : Telegram, GitHub, Gemini, et l'heure locale.
// Les adresses de base sont réglables (TELEGRAM_API, GITHUB_API, GEMINI_API)
// pour pouvoir tout tester en local contre de faux services.

// Fuseau du pays choisi dans l'application (un bot = un auditeur) ; Suisse par défaut.
export const FUSEAU = "Europe/Zurich";
let fuseauActuel = FUSEAU;
export function definirFuseau(fuseau) {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: fuseau });
    fuseauActuel = fuseau;
  } catch { /* fuseau inconnu : on garde le précédent */ }
}
export function fuseau() { return fuseauActuel; }

export function maintenantLocal(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: fuseauActuel, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, heure: `${p.hour}:${p.minute}`, iso: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` };
}

// Instant (millisecondes) correspondant à une date et une heure locales.
export function instantLocal(dateIso, heure) {
  const [a, m, j] = dateIso.split("-").map(Number);
  const [h, mn] = heure.split(":").map(Number);
  const voulu = Date.UTC(a, m - 1, j, h, mn);
  let t = voulu;
  for (let essai = 0; essai < 3; essai++) {
    const local = maintenantLocal(new Date(t));
    const [la, lm, lj] = local.date.split("-").map(Number);
    const [lh, lmn] = local.heure.split(":").map(Number);
    const ecart = Date.UTC(la, lm - 1, lj, lh, lmn) - voulu;
    if (!ecart) break;
    t -= ecart;
  }
  return t;
}

// ───────────────────────────────── Telegram ─────────────────────────────────

export class Telegram {
  constructor(env) {
    this.base = `${env.TELEGRAM_API || "https://api.telegram.org"}/bot${env.TELEGRAM_BOT_TOKEN}`;
    this.fichiers = `${env.TELEGRAM_API || "https://api.telegram.org"}/file/bot${env.TELEGRAM_BOT_TOKEN}`;
    this.chat = env.TELEGRAM_CHAT_ID;
  }

  async appeler(methode, corps = {}) {
    const r = await fetch(`${this.base}/${methode}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps),
    });
    const donnees = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
    if (!donnees.ok && !/message is not modified/.test(donnees.description || "")) {
      console.log(`Telegram ${methode} : ${donnees.description}`);
    }
    return donnees;
  }

  envoyer(texte, options = {}) {
    return this.appeler("sendMessage", {
      chat_id: this.chat, text: tronquer(texte, 4000), parse_mode: "HTML",
      link_preview_options: { is_disabled: true }, ...options,
    });
  }

  modifier(messageId, texte, clavier) {
    return this.appeler("editMessageText", {
      chat_id: this.chat, message_id: messageId, text: tronquer(texte, 4000), parse_mode: "HTML",
      link_preview_options: { is_disabled: true }, reply_markup: clavier ? { inline_keyboard: clavier } : undefined,
    });
  }

  modifierBoutons(messageId, clavier) {
    return this.appeler("editMessageReplyMarkup", {
      chat_id: this.chat, message_id: messageId, reply_markup: { inline_keyboard: clavier || [] },
    });
  }

  repondreBouton(id, texte = "", alerte = false) {
    return this.appeler("answerCallbackQuery", { callback_query_id: id, text: texte.slice(0, 190), show_alert: alerte });
  }

  ecrit() {
    return this.appeler("sendChatAction", { chat_id: this.chat, action: "typing" });
  }

  async fichier(identifiant) {
    const infos = await this.appeler("getFile", { file_id: identifiant });
    if (!infos.ok) return null;
    const r = await fetch(`${this.fichiers}/${infos.result.file_path}`);
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  }
}

export function tronquer(texte, max) {
  const t = String(texte ?? "");
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export function echapper(t) {
  return String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ────────────────────────────────── GitHub ──────────────────────────────────

export class GitHub {
  constructor(env) {
    this.base = `${env.GITHUB_API || "https://api.github.com"}/repos/${env.DEPOT}`;
    this.jeton = env.GITHUB_TOKEN;
  }

  appeler(chemin, options = {}) {
    return fetch(`${this.base}${chemin}`, {
      ...options,
      headers: { Authorization: `Bearer ${this.jeton}`, Accept: "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "podcast-matin-bot",
                 ...(options.body ? { "Content-Type": "application/json" } : {}) },
    });
  }

  async lire(chemin) {
    const r = await this.appeler(`/contents/${chemin}?ref=main`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub refuse la lecture de ${chemin} (HTTP ${r.status})`);
    const donnees = await r.json();
    const octets = Uint8Array.from(atob(String(donnees.content).replace(/\n/g, "")), (c) => c.charCodeAt(0));
    return { texte: new TextDecoder().decode(octets), sha: donnees.sha };
  }

  async ecrire(chemin, texte, message) {
    for (let essai = 0; essai < 3; essai++) {
      const actuel = await this.lire(chemin);
      if (actuel && actuel.texte === texte) return true;
      const corps = { message, content: base64(new TextEncoder().encode(texte)), branch: "main" };
      if (actuel) corps.sha = actuel.sha;
      const r = await this.appeler(`/contents/${chemin}`, { method: "PUT", body: JSON.stringify(corps) });
      if (r.ok) return true;
      if (r.status !== 409 && r.status !== 422) throw new Error(`GitHub refuse l'écriture de ${chemin} (HTTP ${r.status})`);
    }
    return false;
  }

  async lancer(workflow, entrees = {}) {
    const r = await this.appeler(`/actions/workflows/${workflow}/dispatches`, {
      method: "POST", body: JSON.stringify({ ref: "main", inputs: entrees }),
    });
    if (!r.ok) throw new Error(`GitHub refuse de lancer ${workflow} (HTTP ${r.status})`);
    return true;
  }
}

export function base64(octets) {
  let binaire = "";
  for (let i = 0; i < octets.length; i += 0x8000) binaire += String.fromCharCode(...octets.subarray(i, i + 0x8000));
  return btoa(binaire);
}

// ────────────────────────────────── Gemini ──────────────────────────────────

export const MODELES_LEGERS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

export async function demanderGemini(env, systeme, contenus, schema, modeles = MODELES_LEGERS) {
  const url = `${env.GEMINI_API || "https://generativelanguage.googleapis.com"}/v1beta/interactions`;
  const entree = typeof contenus === "string" ? [{ type: "text", text: contenus }] : contenus;
  const variantes = [
    { response_format: { type: "text", mime_type: "application/json", schema }, input: entree },
    { response_format: { type: "text", mime_type: "application/json" },
      input: [...entree, { type: "text", text: `Réponds uniquement par un objet JSON conforme à ce schéma : ${JSON.stringify(schema)}` }] },
  ];
  let derniere = "aucun modèle";
  for (const variante of variantes) {
    for (const modele of modeles) {
      let r;
      try {
        r = await fetch(url, {
          method: "POST", headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ model: modele, system_instruction: systeme, store: false, ...variante }),
        });
      } catch (erreur) {
        derniere = `${modele} : ${erreur.message}`;
        continue;
      }
      if (r.ok) {
        const donnees = await r.json();
        const texte = (donnees.steps || []).filter((s) => s.type === "model_output")
          .flatMap((s) => s.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
        const debut = texte.indexOf("{"), fin = texte.lastIndexOf("}");
        if (debut >= 0 && fin > debut) {
          try { return JSON.parse(texte.slice(debut, fin + 1)); } catch { /* variante suivante */ }
        }
        derniere = `${modele} : réponse sans JSON`;
        continue;
      }
      derniere = `${modele} : HTTP ${r.status} ${(await r.text()).slice(0, 200)}`;
      if (r.status === 400) break;
    }
  }
  throw new Error(derniere);
}

export async function empreinte(texte, longueur = 48) {
  const octets = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texte));
  return [...new Uint8Array(octets)].map((o) => o.toString(16).padStart(2, "0")).join("").slice(0, longueur);
}

// Secret partagé : vérifie les appels de Telegram et de GitHub (dérivé du jeton du bot).
export function secretPartage(env) {
  return empreinte(`podcast:${env.TELEGRAM_BOT_TOKEN}`);
}
