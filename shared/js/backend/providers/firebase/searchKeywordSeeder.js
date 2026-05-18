import {
  collection,
  doc,
  getDocs,
  query,
  updateDoc,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { firebaseDb } from "./firebaseConfig.js";

const TOKEN_SEPARATOR = /[^a-z0-9]+/gi;
const MIN_TOKEN_LENGTH = 2;

function normalizeText(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .toLowerCase()
    .trim()
    .replace(TOKEN_SEPARATOR, " ")
    .replace(/\s+/g, " ");
}

function tokenizeText(text) {
  const normalized = normalizeText(text);
  return [...new Set(
    normalized
      .split(" ")
      .filter((token) => token.length >= MIN_TOKEN_LENGTH)
  )];
}

export function buildSearchKeywords(artisanData = {}) {
  const sourceTexts = [
    artisanData.name,
    artisanData.specialty,
    artisanData.category,
    artisanData.location,
    ...(artisanData.commonSearchPhrases || [])
  ];

  const tokens = sourceTexts
    .filter(Boolean)
    .flatMap(tokenizeText)
    .map((token) => token.toLowerCase());

  return [...new Set(tokens)];
}

export async function seedArtisanSearchKeywords(artisanId, artisanData) {
  if (!artisanId || !artisanData) {
    throw new Error("artisanId and artisanData are required to seed search keywords.");
  }

  const keywords = buildSearchKeywords(artisanData);
  const artisanRef = doc(firebaseDb, "artisans", artisanId);
  await updateDoc(artisanRef, { searchKeywords: keywords });
  return keywords;
}

export async function seedAllArtisanSearchKeywords(batchSize = 500) {
  const artisanCollection = collection(firebaseDb, "artisans");
  const artisanSnapshot = await getDocs(query(artisanCollection));
  const batch = writeBatch(firebaseDb);
  let batchCount = 0;

  artisanSnapshot.docs.forEach((docSnapshot) => {
    const artisanData = docSnapshot.data();
    const keywords = buildSearchKeywords(artisanData);
    const artisanRef = doc(firebaseDb, "artisans", docSnapshot.id);
    batch.update(artisanRef, { searchKeywords: keywords });
    batchCount += 1;

    if (batchCount >= batchSize) {
      batch.commit();
      batchCount = 0;
    }
  });

  if (batchCount > 0) {
    await batch.commit();
  }
}

/*
  Usage example:

  import { seedAllArtisanSearchKeywords } from "./searchKeywordSeeder.js";
  await seedAllArtisanSearchKeywords();

  Or for a single artisan:
  await seedArtisanSearchKeywords(artisanId, artisanPayload);
*/
