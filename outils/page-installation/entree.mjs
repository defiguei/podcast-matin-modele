// Outils de la page d'installation (docs/installer/), réunis en un seul fichier
// (docs/installer/outils.js) : npm ci && npm run fabriquer.
//  - sceller : chiffre une valeur pour un secret GitHub (« sealed box » de libsodium,
//    exigée par l'API des secrets : X25519 + XSalsa20-Poly1305, nonce = BLAKE2b-192
//    de la clé éphémère et de la clé du dépôt) ;
//  - ouvrirSceau : l'inverse, pour les tests seulement ;
//  - qrSvg : un QR code en SVG (lien de l'application à scanner avec le téléphone).
import nacl from "tweetnacl";
import { blake2b } from "blakejs";
import qrcode from "qrcode-generator";

// Hasard du navigateur (et de Node pour les tests) : tweetnacl ne le trouve pas seul hors d'une page.
nacl.setPRNG((x, n) => {
  const v = globalThis.crypto.getRandomValues(new Uint8Array(n));
  for (let i = 0; i < n; i++) x[i] = v[i];
});

const octets = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const base64 = (u8) => btoa(String.fromCharCode(...u8));

function nonce(ephemere, destinataire) {
  const tout = new Uint8Array(64);
  tout.set(ephemere, 0);
  tout.set(destinataire, 32);
  return blake2b(tout, undefined, 24);
}

// valeur : texte ; clePublique : la clé (base64) donnée par GitHub. Renvoie le base64 à envoyer.
export function sceller(valeur, clePublique) {
  const destinataire = octets(clePublique);
  const eph = nacl.box.keyPair();
  const message = new TextEncoder().encode(valeur);
  const chiffre = nacl.box(message, nonce(eph.publicKey, destinataire), destinataire, eph.secretKey);
  const sortie = new Uint8Array(32 + chiffre.length);
  sortie.set(eph.publicKey, 0);
  sortie.set(chiffre, 32);
  return base64(sortie);
}

export function ouvrirSceau(scelle, clePublique, cleSecrete) {
  const tout = octets(scelle);
  const eph = tout.slice(0, 32);
  const ouvert = nacl.box.open(tout.slice(32), nonce(eph, octets(clePublique)), eph, octets(cleSecrete));
  return ouvert ? new TextDecoder().decode(ouvert) : null;
}

export function pairePourTests() {
  const p = nacl.box.keyPair();
  return { publique: base64(p.publicKey), secrete: base64(p.secretKey) };
}

export function qrSvg(texte, taille = 6) {
  const qr = qrcode(0, "M");
  qr.addData(texte);
  qr.make();
  return qr.createSvgTag({ cellSize: taille, margin: 2, scalable: true });
}
