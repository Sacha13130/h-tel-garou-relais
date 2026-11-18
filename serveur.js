// Le relais de L'Hôtel Garou (Node.js, sans rien à installer).
// Il fait passer les messages entre l'hôte et les joueurs d'une même salle (un code à 4 chiffres).
// Lancer : node serveur.js   (le port vient de la variable PORT, sinon 10000)
//
// Messages envoyés aux téléphones : [0, id] bienvenue · [1, de, ...] données · [2, id] arrivée · [3, id] départ · [9, texte] erreur
// Messages reçus des téléphones   : [1, pour, ...] données (pour 0 = tout le monde, pour < 0 = tous sauf -pour) · [4, id] renvoyer

"use strict";
const http = require("http");
const crypto = require("crypto");

const MAX_JOUEURS = 8;
const salles = new Map(); // code -> { hote, joueurs: Map<id, client> }

// ------------------------------------------------------------------ les salles

function entier(type, n) {
  const b = Buffer.alloc(5);
  b[0] = type;
  b.writeInt32LE(n, 1);
  return b;
}

function erreur(c, texte) {
  c.envoyer(Buffer.concat([Buffer.from([9]), Buffer.from(texte, "utf8")]));
  c.fermer();
}

function ouvert(c, code, role) {
  code = String(code || "").slice(0, 12);
  if (!code) return erreur(c, "Il manque le code de la salle.");
  if (role === "hote") {
    if (salles.has(code)) return erreur(c, "Cette salle existe déjà.");
    c.salle = code;
    c.id = 1;
    salles.set(code, { hote: c, joueurs: new Map() });
    c.envoyer(entier(0, 1));
    return;
  }
  const s = salles.get(code);
  if (!s) return erreur(c, "Salle introuvable : vérifie le code.");
  if (s.joueurs.size + 1 >= MAX_JOUEURS) return erreur(c, "La salle est pleine.");
  let id;
  do { id = 2 + Math.floor(Math.random() * 2000000000); } while (s.joueurs.has(id));
  c.salle = code;
  c.id = id;
  s.joueurs.set(id, c);
  c.envoyer(entier(0, id));
  s.hote.envoyer(entier(2, id));
}

function recu(c, octets) {
  const s = salles.get(c.salle);
  if (!s || octets.length < 5) return;
  const pour = octets.readInt32LE(1);
  if (octets[0] === 4) {
    if (c.id === 1) { const j = s.joueurs.get(pour); if (j) j.fermer(); }
    return;
  }
  if (octets[0] !== 1) return;
  const sortie = Buffer.from(octets);
  sortie.writeInt32LE(c.id, 1);
  for (const d of [s.hote, ...s.joueurs.values()]) {
    if (d === c) continue;
    if (pour === 0 || (pour < 0 && d.id !== -pour) || d.id === pour) d.envoyer(sortie);
  }
}

function ferme(c) {
  const s = salles.get(c.salle);
  if (!s) return;
  if (c.id === 1) {
    if (s.hote !== c) return;
    salles.delete(c.salle);
    for (const j of s.joueurs.values()) j.fermer();
    return;
  }
  if (s.joueurs.delete(c.id)) s.hote.envoyer(entier(3, c.id));
}

// ------------------------------------------------------------------ le WebSocket, à la main

function trame(opcode, donnees) {
  const n = donnees.length;
  let tete;
  if (n < 126) {
    tete = Buffer.from([0x80 | opcode, n]);
  } else if (n < 65536) {
    tete = Buffer.alloc(4);
    tete[0] = 0x80 | opcode; tete[1] = 126; tete.writeUInt16BE(n, 2);
  } else {
    tete = Buffer.alloc(10);
    tete[0] = 0x80 | opcode; tete[1] = 127; tete.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([tete, donnees]);
}

function brancher(socket, code, role) {
  let tampon = Buffer.alloc(0);
  let morceaux = [];
  let ferme_deja = false;
  const c = {
    envoyer(b) { if (!socket.destroyed) socket.write(trame(2, b)); },
    fermer() {
      if (ferme_deja) return;
      ferme_deja = true;
      if (!socket.destroyed) { socket.write(trame(8, Buffer.alloc(0))); socket.end(); }
      ferme(c);
    },
  };
  socket.setNoDelay(true);
  socket.on("data", (morceau) => {
    tampon = Buffer.concat([tampon, morceau]);
    for (;;) {
      if (tampon.length < 2) return;
      const fin = (tampon[0] & 0x80) !== 0;
      const opcode = tampon[0] & 0x0f;
      const masque = (tampon[1] & 0x80) !== 0;
      let n = tampon[1] & 0x7f;
      let pos = 2;
      if (n === 126) { if (tampon.length < 4) return; n = tampon.readUInt16BE(2); pos = 4; }
      else if (n === 127) { if (tampon.length < 10) return; n = Number(tampon.readBigUInt64BE(2)); pos = 10; }
      if (n > 4 * 1024 * 1024) return c.fermer();
      const cle_pos = pos;
      if (masque) pos += 4;
      if (tampon.length < pos + n) return;
      let donnees = Buffer.from(tampon.subarray(pos, pos + n));
      if (masque) for (let i = 0; i < n; i++) donnees[i] ^= tampon[cle_pos + (i % 4)];
      tampon = tampon.subarray(pos + n);
      if (opcode === 8) return c.fermer();
      if (opcode === 9) { if (!socket.destroyed) socket.write(trame(10, donnees)); continue; }
      if (opcode === 10) continue;
      if (opcode === 0 || opcode === 1 || opcode === 2) {
        morceaux.push(donnees);
        if (fin) {
          const tout = Buffer.concat(morceaux);
          morceaux = [];
          recu(c, tout);
        }
      }
    }
  });
  socket.on("close", () => { ferme_deja = true; ferme(c); });
  socket.on("error", () => { ferme_deja = true; ferme(c); });
  ouvert(c, code, role);
}

const serveur = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(`L'Hôtel Garou : le relais marche ! (${salles.size} salle(s))`);
});

serveur.on("upgrade", (req, socket) => {
  const cle = req.headers["sec-websocket-key"];
  if (!cle || (req.headers.upgrade || "").toLowerCase() !== "websocket") return socket.destroy();
  const accepte = crypto.createHash("sha1").update(cle + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accepte + "\r\n\r\n");
  const url = new URL(req.url, "http://relais");
  brancher(socket, url.searchParams.get("salle"), url.searchParams.get("role"));
});

// Un petit « ping » toutes les 25 s : les connexions restent ouvertes (et le serveur ne s'endort pas en pleine partie).
setInterval(() => {
  for (const s of salles.values()) for (const c of [s.hote, ...s.joueurs.values()]) c.envoyer(Buffer.from([7]));
}, 25000);

const port = Number(process.env.PORT || 10000);
serveur.listen(port, () => console.log("Relais de L'Hôtel Garou prêt sur le port " + port));
