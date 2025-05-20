const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_INTEGRATION;
const DB_NAME = 'bonsai_garden'; // You can change this as needed
const COLLECTION_NAME = 'rpg_heroes';

app.use(cors());

let cachedClient = null;
let cachedDb = null;

async function getDb() {
  if (cachedDb) return cachedDb;
  if (!MONGODB_URI) throw new Error('MONGODB_INTEGRATION env variable not set');
  const client = await MongoClient.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  cachedClient = client;
  cachedDb = client.db(DB_NAME);
  return cachedDb;
}

app.get('/rpg-heroes', async (req, res) => {
  try {
    const db = await getDb();
    const collection = db.collection(COLLECTION_NAME);
    let heroes = await collection.find({}).toArray();
    // Remove imageResponse property from each hero object
    heroes = heroes.map(hero => {
      if ('imageResponse' in hero) {
        const { imageResponse, ...rest } = hero;
        return rest;
      }
      return hero;
    });
    res.json(heroes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch RPG heroes' });
  }
});

app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);
});
