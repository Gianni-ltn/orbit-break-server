/**
 * ORBIT BREAK — Backend de vérification des paiements PayPal (IPN)
 * ------------------------------------------------------------
 * Ce serveur est la SEULE source de vérité pour le solde de coins.
 * AUCUN coin n'est jamais crédité sans confirmation réelle de PayPal
 * (vérification IPN officielle, serveur à serveur — jamais via le
 * navigateur du joueur).
 *
 * NOUVEAU : catalogue de prix verrouillé côté serveur (PRICE_CATALOG).
 * Le serveur ne fait plus confiance au montant envoyé par le navigateur :
 * chaque dépense (reasonKey) doit correspondre exactement au prix
 * catalogué ici. Si un joueur modifie le JS pour tenter d'envoyer un
 * montant différent, la requête est rejetée. Garde ce catalogue
 * SYNCHRONISÉ avec les tableaux SKINS / WORLDS du fichier game.js.
 *
 * DÉPLOIEMENT CONSEILLÉ : Render.com ou Railway (Node.js natif).
 * Le fichier database.json ci-dessous suffit pour démarrer ; pour un
 * vrai lancement à volume, remplace-le par une vraie base de données
 * (Postgres/Supabase, MongoDB Atlas...).
 *
 * VARIABLES D'ENVIRONNEMENT À CONFIGURER SUR TON HÉBERGEUR :
 *   PAYPAL_BUSINESS_EMAIL = giannilatona2@gmail.com
 *   PAYPAL_MODE           = live     (mets "sandbox" pour tester sans vrai argent)
 */

const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: false })); // PayPal envoie du form-urlencoded
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PAYPAL_BUSINESS_EMAIL = process.env.PAYPAL_BUSINESS_EMAIL || 'giannilatona2@gmail.com';
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'live';
const PAYPAL_VERIFY_URL = PAYPAL_MODE === 'sandbox'
  ? 'https://ipnpb.sandbox.paypal.com/cgi-bin/webscr'
  : 'https://ipnpb.paypal.com/cgi-bin/webscr';

/* ---------- Packs de coins (achat avec argent réel) ----------
   DOIT être identique à COIN_PACKS côté front (game.js).
------------------------------------------------------------------ */
const COIN_PACKS = {
  starter:   { coins: 200,   price: 1.00 },
  popular:   { coins: 1100,  price: 5.00 },
  advantage: { coins: 2400,  price: 10.00 },
  mega:      { coins: 6500,  price: 25.00 },
  ultimate:  { coins: 15000, price: 50.00 }
};

/* ---------- Catalogue de prix pour les DÉPENSES en jeu ----------
   DOIT être identique aux coûts définis dans SKINS / WORLDS et aux
   coûts de continue côté front (game.js). Toute clé absente d'ici
   est automatiquement refusée par /api/spend.
------------------------------------------------------------------- */
const PRICE_CATALOG = {
  remove_ads: 400,
  continue_pack3: 50,

  continue_w1: 20, continue_w2: 25, continue_w3: 30, continue_w4: 35, continue_w5: 40,
  continue_w6: 45, continue_w7: 50, continue_w8: 55, continue_w9: 60, continue_w10: 65,

  skin_violet: 400, skin_gold: 400, skin_matrix: 400, skin_magma: 400,
  skin_diamond: 1000,
  skin_prism: 2000,
  skin_nova: 4000, skin_aurora: 4000,
  skin_singularity: 8000,

  world_w2: 500, world_w3: 1200, world_w4: 2000, world_w5: 3000,
  world_w6: 4500, world_w7: 6000, world_w8: 8000, world_w9: 11000, world_w10: 15000
};

/* ---------- Stockage (fichier JSON — suffisant pour démarrer) ---------- */
const DB_PATH = path.join(__dirname, 'database.json');

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ users: {}, processedTransactions: {} }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}
function saveDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
function getUser(db, userId) {
  if (!db.users[userId]) db.users[userId] = { coins: 0 };
  return db.users[userId];
}

/* ---------- Solde d'un joueur ---------- */
app.get('/api/balance/:userId', (req, res) => {
  const db = loadDB();
  const user = getUser(db, req.params.userId);
  saveDB(db);
  res.json({ coins: user.coins });
});

/* ---------- Dépense de coins (achats en jeu, prix verrouillé) ---------- */
app.post('/api/spend', (req, res) => {
  const { userId, reasonKey, amount } = req.body;

  if (!userId || !reasonKey || typeof amount !== 'number') {
    return res.status(400).json({ error: 'Requête invalide' });
  }

  const officialPrice = PRICE_CATALOG[reasonKey];
  if (officialPrice === undefined) {
    console.warn(`[SPEND] Clé inconnue rejetée : "${reasonKey}"`);
    return res.status(400).json({ error: 'Article inconnu' });
  }
  if (amount !== officialPrice) {
    console.warn(`[SPEND] Prix falsifié rejeté : ${userId} a envoyé ${amount} pour "${reasonKey}" (prix réel : ${officialPrice})`);
    return res.status(400).json({ error: 'Prix invalide' });
  }

  const db = loadDB();
  const user = getUser(db, userId);
  if (user.coins < officialPrice) {
    return res.status(402).json({ error: 'Solde insuffisant', coins: user.coins });
  }
  user.coins -= officialPrice;
  saveDB(db);
  console.log(`[SPEND] ${userId} a dépensé ${officialPrice} coins pour "${reasonKey}"`);
  res.json({ success: true, coins: user.coins });
});

/* ---------- IPN PayPal (paiement réel) ----------
   PayPal appelle CETTE route directement, serveur à serveur, après
   chaque paiement. Le navigateur du joueur n'intervient jamais ici.
--------------------------------------------------------------------- */
app.post('/api/paypal-ipn', async (req, res) => {
  res.sendStatus(200); // réponse immédiate obligatoire, sinon PayPal retente en boucle

  try {
    const params = req.body;

    const verifyBody = 'cmd=_notify-validate&' + new URLSearchParams(params).toString();
    const verifyResponse = await fetch(PAYPAL_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: verifyBody
    });
    const verifyText = await verifyResponse.text();

    if (verifyText !== 'VERIFIED') {
      console.warn('[IPN] Rejeté — non vérifié par PayPal :', verifyText);
      return;
    }

    const txnId = params.txn_id;
    const paymentStatus = params.payment_status;
    const receiverEmail = (params.receiver_email || params.business || '').toLowerCase();
    const grossAmount = parseFloat(params.mc_gross);
    const currency = params.mc_currency;
    const custom = params.custom || ''; // format : "userId|packId"
    const [userId, packId] = custom.split('|');

    if (paymentStatus !== 'Completed') { console.warn('[IPN] Statut non complété :', paymentStatus); return; }
    if (receiverEmail !== PAYPAL_BUSINESS_EMAIL.toLowerCase()) { console.warn('[IPN] Email destinataire suspect :', receiverEmail); return; }

    const pack = COIN_PACKS[packId];
    if (!pack) { console.warn('[IPN] Pack inconnu :', packId); return; }
    if (currency !== 'EUR' || Math.abs(grossAmount - pack.price) > 0.01) {
      console.warn('[IPN] Montant ne correspond pas au pack :', grossAmount, 'attendu', pack.price);
      return;
    }
    if (!userId) { console.warn('[IPN] userId manquant'); return; }

    const db = loadDB();
    if (db.processedTransactions[txnId]) {
      console.log('[IPN] Transaction déjà traitée, ignorée :', txnId);
      return;
    }

    const user = getUser(db, userId);
    user.coins += pack.coins;
    db.processedTransactions[txnId] = { userId, packId, coins: pack.coins, date: new Date().toISOString() };
    saveDB(db);

    console.log(`[IPN] ✅ Paiement confirmé — ${pack.coins} coins crédités à ${userId} (txn ${txnId})`);
  } catch (err) {
    console.error('[IPN] Erreur de traitement :', err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur Orbit Break lancé sur le port ${PORT}`));
