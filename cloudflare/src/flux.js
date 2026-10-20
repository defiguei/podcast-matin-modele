// Flux privé du podcast (RSS) : pour écouter les épisodes dans Apple Podcasts,
// AntennaPod ou toute application qui accepte une adresse de flux. L'adresse
// contient un jeton secret ; la changer coupe l'ancienne. Les fichiers sont gardés
// par le bot (audio.js) ; ceux d'avant la version 2026-10-21.4 restent chez Telegram.

const xml = (t) => String(t ?? "").replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
const MOIS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const JOURS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function dateRss(ms) {
  const d = new Date(ms);
  const deux = (n) => String(n).padStart(2, "0");
  return `${JOURS[d.getUTCDay()]}, ${deux(d.getUTCDate())} ${MOIS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${deux(d.getUTCHours())}:${deux(d.getUTCMinutes())}:00 GMT`;
}

const duree = (s) => {
  s = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

// Identifiant d'un épisode dans les adresses du flux (sans « : »).
export const cleFlux = (ep) => `${ep.date}-${ep.message_id || 0}`;
export function episodeDeCle(episodes, cle) {
  const m = /^(\d{4}-\d{2}-\d{2})-(\d+)$/.exec(String(cle || ""));
  if (!m) return null;
  return (episodes || []).find((ep) => ep.date === m[1] && String(ep.message_id || 0) === m[2]) || null;
}

// ep.instant : millisecondes de l'envoi (calculé par l'appelant, avec le fuseau du pays).
export function fluxRss({ episodes, base, titre, auteur, langue = "fr" }) {
  const avecAudio = (episodes || []).filter((ep) => ep.audio || ep.file_id).slice(-30).reverse();
  const derniere = avecAudio.find((ep) => ep.pochette || ep.pochette_id);
  const image = derniere ? `${base}/${cleFlux(derniere)}.jpg` : "";
  const items = avecAudio.map((ep) => {
    const cle = cleFlux(ep);
    const chapitres = (ep.chapitres || []).map(([t, nom]) => `${duree(t)} ${nom}`).join("\n");
    const sources = (ep.sources || []).map((s) => `<li><a href="${xml(s.url)}">${xml(s.titre || s.url)}</a></li>`).join("");
    const description = [ep.sujets?.length ? `Au programme : ${ep.sujets.join(" · ")}.` : "", chapitres].filter(Boolean).join("\n\n");
    return `    <item>
      <title>${xml(ep.titre || `Épisode du ${ep.date}`)}</title>
      <guid isPermaLink="false">podcast-matin-${xml(cle)}</guid>
      <pubDate>${dateRss(ep.instant)}</pubDate>
      <enclosure url="${xml(`${base}/${cle}.mp3`)}" length="${Number(ep.taille) || 0}" type="audio/mpeg"/>
      <itunes:duration>${duree(ep.duree)}</itunes:duration>
      <description>${xml(description)}</description>
      <content:encoded><![CDATA[<p>${xml(description).replace(/\n/g, "<br>")}</p>${sources ? `<p>Sources :</p><ul>${sources}</ul>` : ""}]]></content:encoded>
      ${ep.pochette || ep.pochette_id ? `<itunes:image href="${xml(`${base}/${cle}.jpg`)}"/>` : ""}
      ${(ep.chapitres || []).length ? `<podcast:chapters url="${xml(`${base}/${cle}.json`)}" type="application/json+chapters"/>` : ""}
      <itunes:explicit>false</itunes:explicit>
    </item>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>${xml(titre)}</title>
    <description>Ton podcast du matin, personnel et privé.</description>
    <language>${xml(langue)}</language>
    <link>${xml(base.replace(/\/flux\/.*$/, "/app"))}</link>
    <itunes:author>${xml(auteur)}</itunes:author>
    <itunes:explicit>false</itunes:explicit>
    <itunes:block>Yes</itunes:block>
    <podcast:locked>yes</podcast:locked>
    ${image ? `<itunes:image href="${xml(image)}"/>\n    <image><url>${xml(image)}</url><title>${xml(titre)}</title><link>${xml(base)}</link></image>` : ""}
${items}
  </channel>
</rss>
`;
}

export function chapitresJson(ep) {
  return { version: "1.2.0", chapters: (ep.chapitres || []).map(([t, nom]) => ({ startTime: Math.max(0, Number(t) || 0), title: String(nom || "") })) };
}

export function jetonValide(jeton) {
  return typeof jeton === "string" && /^[0-9a-f]{32}$/.test(jeton);
}

export function nouveauJeton() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((o) => o.toString(16).padStart(2, "0")).join("");
}
