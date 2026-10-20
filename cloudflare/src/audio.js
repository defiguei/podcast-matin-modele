// Fichiers des épisodes (MP3, pochettes, extraits de voix), gardés par le bot
// lui-même : plus besoin de Telegram pour les écouter.
//
// Un Durable Object par mois (« 2026-10 ») et un pour les extraits de voix
// (« voix ») : chacun reste petit, et un mois entier s'efface d'un coup quand
// il a plus d'un an. Le stockage ne garde pas plus de 2 Mo par valeur : chaque
// fichier est rangé en morceaux d'1 Mio, remis bout à bout à la lecture. Le
// lecteur reçoit toujours le fichier d'origine, octet pour octet ; une demande
// « Range » (avancer dans l'audio, exigée par les iPhone) ne lit que les
// morceaux utiles.

import { DurableObject } from "cloudflare:workers";

export const TAILLE_MORCEAU = 1024 * 1024;
export const TAILLE_MAX = 40 * 1000 * 1000;

// « 2026-10/2026-10-21-071502.mp3 » ou « voix/Kore-Puck-1729490000.mp3 ».
const NOM = /^(\d{4}-(?:0[1-9]|1[0-2])|voix)\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const nomValide = (nom) => typeof nom === "string" && NOM.test(nom) && !nom.includes("..");
export const objetDuNom = (nom) => nom.slice(0, nom.indexOf("/"));
export const TYPES = { mp3: "audio/mpeg", jpg: "image/jpeg" };
export const typeDuNom = (nom) => TYPES[nom.slice(nom.lastIndexOf(".") + 1).toLowerCase()] || null;

// Le Worker joint l'objet qui garde ce fichier (ou ce mois).
export function objetAudio(env, objet) {
  return env.AUDIO.get(env.AUDIO.idFromName(objet));
}

// Plage demandée (« bytes=debut-fin », « bytes=debut- », « bytes=-n ») : [debut, fin] inclus,
// null sans plage, false si elle est hors du fichier.
export function lirePlage(plage, taille) {
  const m = plage && /^bytes=(\d*)-(\d*)$/.exec(plage.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let debut, fin;
  if (m[1] === "") { debut = Math.max(0, taille - Number(m[2])); fin = taille - 1; }
  else { debut = Number(m[1]); fin = m[2] === "" ? taille - 1 : Math.min(Number(m[2]), taille - 1); }
  if (taille === 0 || debut >= taille || debut > fin) return false;
  return [debut, fin];
}

export class Audio extends DurableObject {
  async fetch(requete) {
    const url = new URL(requete.url);
    const stockage = this.ctx.storage;
    if (url.pathname === "/liste") {
      const fiches = await stockage.list({ prefix: "f:" });
      return Response.json([...fiches].map(([cle, f]) => ({ nom: cle.slice(2), taille: f.taille, cree: f.cree })));
    }
    if (url.pathname === "/tout" && requete.method === "DELETE") {
      await stockage.deleteAll();
      return Response.json({ ok: true });
    }
    const nom = decodeURIComponent(url.pathname.replace(/^\/f\//, ""));
    if (!nomValide(nom)) return new Response("nom de fichier refusé", { status: 400 });
    const fiche = await stockage.get(`f:${nom}`);

    if (requete.method === "PUT") {
      const octets = new Uint8Array(await requete.arrayBuffer());
      if (!octets.length || octets.length > TAILLE_MAX) return Response.json({ ok: false, erreur: "taille refusée" }, { status: 413 });
      if (fiche) await this.effacer(nom, fiche);
      const morceaux = Math.ceil(octets.length / TAILLE_MORCEAU);
      for (let i = 0; i < morceaux; i++) {
        await stockage.put(`m:${nom}:${i}`, octets.slice(i * TAILLE_MORCEAU, (i + 1) * TAILLE_MORCEAU));
      }
      // La fiche en dernier : un fichier à moitié écrit n'est jamais lu.
      const nouvelle = { taille: octets.length, morceaux, type: typeDuNom(nom) || requete.headers.get("Content-Type") || "application/octet-stream", cree: Date.now() };
      await stockage.put(`f:${nom}`, nouvelle);
      return Response.json({ ok: true, nom, taille: nouvelle.taille });
    }
    if (requete.method === "DELETE") {
      if (fiche) await this.effacer(nom, fiche);
      return Response.json({ ok: true, efface: Boolean(fiche) });
    }
    if (requete.method !== "GET" && requete.method !== "HEAD") return new Response("méthode refusée", { status: 405 });
    if (!fiche) return new Response("fichier introuvable", { status: 404 });

    const entetes = { "Content-Type": fiche.type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=86400" };
    const plage = lirePlage(requete.headers.get("Range"), fiche.taille);
    if (plage === false) return new Response(null, { status: 416, headers: { ...entetes, "Content-Range": `bytes */${fiche.taille}` } });
    const [debut, fin] = plage || [0, fiche.taille - 1];
    const longueur = fin - debut + 1;
    if (plage) { entetes["Content-Range"] = `bytes ${debut}-${fin}/${fiche.taille}`; }
    entetes["Content-Length"] = String(longueur);
    const statut = plage ? 206 : 200;
    if (requete.method === "HEAD") return new Response(null, { status: statut, headers: entetes });
    // Seuls les morceaux qui contiennent la plage sont lus, puis recollés.
    const corps = new Uint8Array(longueur);
    let ecrit = 0;
    for (let i = Math.floor(debut / TAILLE_MORCEAU); i <= Math.floor(fin / TAILLE_MORCEAU); i++) {
      const morceau = await stockage.get(`m:${nom}:${i}`);
      if (!morceau) return new Response("fichier abîmé", { status: 500 });
      const base = i * TAILLE_MORCEAU;
      const octets = morceau instanceof Uint8Array ? morceau : new Uint8Array(morceau);
      const partie = octets.subarray(Math.max(0, debut - base), Math.min(morceau.byteLength, fin - base + 1));
      corps.set(partie, ecrit);
      ecrit += partie.length;
    }
    return new Response(corps, { status: statut, headers: entetes });
  }

  async effacer(nom, fiche) {
    const cles = [`f:${nom}`, ...Array.from({ length: fiche.morceaux }, (_, i) => `m:${nom}:${i}`)];
    for (let i = 0; i < cles.length; i += 128) await this.ctx.storage.delete(cles.slice(i, i + 128));
  }
}
