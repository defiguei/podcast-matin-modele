// Données intégrées au podcast (sans réseau) : prénoms du jour, journées et fêtes, jours
// fériés. Mêmes fichiers et mêmes règles que fetes.py, pour que Réglages › Sources › Données
// montre ce que l'épisode recevra aujourd'hui (un test compare avec fetes.py).
import PRENOMS from "../../donnees/prenoms.json" with { type: "json" };
import JOURNEES from "../../donnees/journees.json" with { type: "json" };
import { datePaques, ajouterJours, nomFerie, dateCourte } from "./config.js";

const mmjj = (dateIso) => dateIso.slice(5, 10);
const date = (a, m, j) => `${a}-${String(m).padStart(2, "0")}-${String(j).padStart(2, "0")}`;
const jourSemaine = (dateIso) => (new Date(`${dateIso}T12:00:00Z`).getUTCDay() + 6) % 7; // 0 = lundi
const et = (noms) => noms.length <= 1 ? noms.join("") : `${noms.slice(0, -1).join(", ")} et ${noms.at(-1)}`;

// N-ième jour de la semaine du mois (n = -1 : le dernier), comme _nieme de fetes.py.
function nieme(annee, mois, n, js) {
  if (n > 0) {
    const premier = date(annee, mois, 1);
    const jour = ajouterJours(premier, (js - jourSemaine(premier) + 7) % 7 + 7 * (n - 1));
    return Number(jour.slice(5, 7)) === mois ? jour : null;
  }
  const dernier = ajouterJours(mois === 12 ? date(annee + 1, 1, 1) : date(annee, mois + 1, 1), -1);
  return ajouterJours(dernier, -((jourSemaine(dernier) - js + 7) % 7));
}

// Date d'une règle pour une année (« nth:5:2:6 », « nth:11:4:3+1 », « paques:+49 », « fete_meres_fr »).
export function dateRegle(regle, annee) {
  try {
    if (regle === "fete_meres_fr") {
      const dernier = nieme(annee, 5, -1, 6);
      return dernier === ajouterJours(datePaques(annee), 49) ? ajouterJours(dernier, 7) : dernier;
    }
    if (regle.startsWith("paques:")) return ajouterJours(datePaques(annee), Number(regle.split(":")[1]));
    if (regle.startsWith("nth:")) {
      const [corps, decalage = "0"] = regle.slice(4).split("+");
      const [mois, n, js] = corps.split(":").map(Number);
      const jour = nieme(annee, mois, n, js);
      return jour ? ajouterJours(jour, Number(decalage)) : null;
    }
  } catch { /* règle illisible */ }
  return null;
}

export function prenomsDuJour(dateIso) {
  const f = (PRENOMS.jours || {})[mmjj(dateIso)] || {};
  return { principal: f.principal || [], fete: f.fete || "", aussi: f.aussi || [] };
}

// Les journées du jour rangées comme dans fetes.py : onu, nationales, pays (de l'auditeur), populaires.
export function journeesDuJour(dateIso, pays) {
  const trouvees = [...((JOURNEES.fixes || {})[mmjj(dateIso)] || [])];
  const annee = Number(dateIso.slice(0, 4));
  for (const r of JOURNEES.regles || []) if (dateRegle(r.regle || "", annee) === dateIso) trouvees.push(r);
  const famille = { onu: [], nationales: [], pays: [], populaires: [] };
  for (const e of trouvees) {
    if (e.cat === "onu") famille.onu.push(e);
    else if (e.cat === "nationale") famille.nationales.push(e);
    else {
      const portee = e.portee || [];
      if (pays && !portee.includes("monde") && !portee.includes(pays)) continue;
      famille[e.fiab === "populaire" ? "populaires" : "pays"].push(e);
    }
  }
  famille.nationales.sort((a, b) => (a.iso !== pays) - (b.iso !== pays) || String(a.pays || "").localeCompare(String(b.pays || "")));
  return famille;
}

// Ce que chaque donnée intégrée donne aujourd'hui (onglet Données) : une ligne lisible.
export function apercuDonnees(config, aujourdHui) {
  const p = prenomsDuJour(aujourdHui);
  const saints = p.principal.length ? `On fête les ${et(p.principal)}${p.aussi.length ? ` (aussi : ${et(p.aussi.slice(0, 4))})` : ""}.`
    : p.fete ? `Pas de prénom ce jour-là : ${p.fete}.` : "Aucun prénom pour aujourd'hui.";
  const j = journeesDuJour(aujourdHui, config.pays);
  const morceaux = [
    ...j.onu.map((e) => e.nom), ...j.pays.map((e) => e.nom),
    ...j.nationales.slice(0, 3).map((e) => `${e.pays} : ${e.nom}`),
  ];
  const fetes = morceaux.length ? `${morceaux.slice(0, 4).join(" · ")}${morceaux.length > 4 ? ` · et ${morceaux.length - 4} autre${morceaux.length > 5 ? "s" : ""}` : ""}.`
    : "Rien de particulier aujourd'hui.";
  let feries = "Aucun jour férié dans l'année qui vient.";
  for (let i = 0; i < 366; i++) {
    const d = ajouterJours(aujourdHui, i), nom = nomFerie(config.planning, d);
    if (nom) { feries = i === 0 ? `Aujourd'hui : ${nom}.` : `Prochain : ${nom}, ${dateCourte(d)}${i === 1 ? " (demain)" : ` (dans ${i} jours)`}.`; break; }
  }
  return { saints, fetes, feries };
}
