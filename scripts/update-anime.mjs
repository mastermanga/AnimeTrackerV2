import { google } from "googleapis";
import * as cheerio from "cheerio";

const SHEET_ID =
  process.env.SHEET_ID || "1WuGg-AH0X1x5ZdOswZlwn5KxE-V0TKeYTxovN20E9UE";
const SHEET_NAME = process.env.SHEET_NAME || "Anime";
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
  throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON environment variable.");
}

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

const COL = {
  TITRE: 0,
  SAISON: 1,
  VUS: 2,
  DISPO: 3,
  NB_EP: 4,
  ID_MAL: 5,
  SLUG: 6,
  IMAGE: 7,
};

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "anime-tracker-updater/1.0",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${url}`);
  }

  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 anime-tracker-updater/1.0",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${url}`);
  }

  return res.text();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTitle(title) {
  return String(title || "").replace(/\s+/g, " ").trim();
}

function inferSeasonFromTitle(title) {
  const t = normalizeTitle(title);

  const patterns = [
    /(?:^|\s)(\d+)(?:nd|rd|th)?\s+season$/i,
    /(?:^|\s)season\s+(\d+)$/i,
    /(?:^|\s)saison\s+(\d+)$/i,
    /(?:^|\s)s(\d+)$/i,
    /(?:^|\s)(\d+)$/i,
  ];

  for (const pattern of patterns) {
    const match = t.match(pattern);
    if (match) {
      const n = parseInt(match[1], 10);
      if (!Number.isNaN(n) && n > 0) return n;
    }
  }

  return 1;
}

function stripSeasonFromTitle(title) {
  return normalizeTitle(title)
    .replace(/(?:\s+\d+(?:nd|rd|th)?\s+season)$/i, "")
    .replace(/(?:\s+season\s+\d+)$/i, "")
    .replace(/(?:\s+saison\s+\d+)$/i, "")
    .replace(/(?:\s+s\d+)$/i, "")
    .replace(/(?:\s+\d+)$/i, "")
    .trim();
}

function slugifyForAnimeSama(title) {
  return stripSeasonFromTitle(title)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildAnimeSamaUrl(slug, saison) {
  return `https://anime-sama.to/catalogue/${slug}/saison${saison}/vostfr/`;
}

async function searchMalByTitle(title) {
  const q = encodeURIComponent(title);
  const url = `https://api.jikan.moe/v4/anime?q=${q}&limit=5`;
  const json = await fetchJson(url);

  const list = Array.isArray(json.data) ? json.data : [];
  if (!list.length) return null;

  const exact = list.find((item) => {
    const candidates = [
      item.title,
      item.title_english,
      ...(item.title_synonyms || []),
    ]
      .filter(Boolean)
      .map(normalizeTitle);

    return candidates.includes(normalizeTitle(title));
  });

  return exact || list[0];
}

async function getMalData(rowTitle) {
  const fullTitle = normalizeTitle(rowTitle);
  const baseTitle = stripSeasonFromTitle(fullTitle);

  let anime = await searchMalByTitle(fullTitle);
  await sleep(700);

  if (!anime && baseTitle !== fullTitle) {
    anime = await searchMalByTitle(baseTitle);
    await sleep(700);
  }

  if (!anime) {
    return {
      malId: "",
      image: "",
      nbEpisode: "",
      saison: inferSeasonFromTitle(fullTitle),
    };
  }

  return {
    malId: anime.mal_id ?? "",
    image: anime.images?.jpg?.image_url ?? "",
    nbEpisode: anime.episodes ?? "",
    saison: inferSeasonFromTitle(fullTitle),
    malTitle: anime.title ?? fullTitle,
  };
}

async function resolveAnimeSamaSlug(existingSlug, title, saison) {
  if (existingSlug) {
    try {
      const url = buildAnimeSamaUrl(existingSlug, saison);
      const html = await fetchText(url);
      if (html && html.length > 1000) {
        console.log(`[DEBUG] slug existant valide: ${existingSlug}`);
        return existingSlug;
      }
    } catch {
      console.log(`[DEBUG] slug existant invalide: ${existingSlug}`);
    }
  }

  const candidate = slugifyForAnimeSama(title);

  try {
    const url = buildAnimeSamaUrl(candidate, saison);
    const html = await fetchText(url);
    if (html && html.length > 1000) {
      console.log(`[DEBUG] slug reconstruit valide: ${candidate}`);
      return candidate;
    }
  } catch {
    console.log(`[DEBUG] slug reconstruit invalide: ${candidate}`);
  }

  return existingSlug || candidate;
}

function extractSeasonEpisode(text) {
  const normalized = normalizeTitle(text);

  const match = normalized.match(/saison\s*(\d+)\s*episode\s*(\d+)/i);
  if (!match) return null;

  const saison = parseInt(match[1], 10);
  const episode = parseInt(match[2], 10);

  if (Number.isNaN(saison) || Number.isNaN(episode)) return null;

  return { saison, episode };
}

function extractSlugFromHref(href) {
  if (!href) return "";

  const match = href.match(/\/catalogue\/([^/]+)\//i);
  return match ? match[1].trim() : "";
}

function extractRecentEpisodesFromHtml(html) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  const links = $('a[href*="/catalogue/"]');
  console.log(`[DEBUG] liens catalogue trouvés: ${links.length}`);

  links.each((index, el) => {
    const href = ($(el).attr("href") || "").trim();
    const slug = extractSlugFromHref(href);
    const text = normalizeTitle($(el).text());

    if (!slug) return;

    const parsed = extractSeasonEpisode(text);

    console.log(
      `[DEBUG] lien ${index + 1}: slug="${slug}" href="${href}" text="${text}"`
    );

    if (!parsed) return;

    const key = `${slug}__${parsed.saison}`;
    if (seen.has(key)) return;
    seen.add(key);

    results.push({
      slug,
      saison: parsed.saison,
      episode: parsed.episode,
      href,
      text,
    });
  });

  console.log(`[DEBUG] entrées récentes extraites: ${results.length}`);
  results.forEach((item, i) => {
    console.log(
      `[DEBUG] récent ${i + 1}: slug=${item.slug}, saison=${item.saison}, episode=${item.episode}`
    );
  });

  return results;
}

async function getRecentEpisodesMap() {
  const url = "https://anime-sama.to/";
  console.log(`[DEBUG] récupération homepage Anime-Sama: ${url}`);

  const html = await fetchText(url);
  console.log(`[DEBUG] longueur homepage HTML: ${html.length}`);

  const recentEntries = extractRecentEpisodesFromHtml(html);
  const map = new Map();

  for (const entry of recentEntries) {
    const key = `${entry.slug}__${entry.saison}`;
    const current = map.get(key);

    if (!current || entry.episode > current.episode) {
      map.set(key, entry);
    }
  }

  console.log(`[DEBUG] taille map épisodes récents: ${map.size}`);

  for (const [key, value] of map.entries()) {
    console.log(
      `[DEBUG] map récent: ${key} -> episode ${value.episode}`
    );
  }

  return map;
}

async function readSheetRows() {
  const range = `${SHEET_NAME}!A2:H`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });

  return res.data.values || [];
}

function padRow(row) {
  const copy = [...row];
  while (copy.length < 8) copy.push("");
  return copy;
}

async function writeRow(rowIndex, rowValues) {
  const range = `${SHEET_NAME}!A${rowIndex}:H${rowIndex}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [rowValues],
    },
  });
}

async function main() {
  console.log("=== SCRIPT START ===");
  console.log("Reading sheet...");
  const rows = await readSheetRows();
  console.log(`Found ${rows.length} anime rows.`);

  let recentEpisodesMap = new Map();

  try {
    recentEpisodesMap = await getRecentEpisodesMap();
  } catch (error) {
    console.warn(`[DEBUG] erreur récupération récents Anime-Sama: ${error.message}`);
  }

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 2;
    const row = padRow(rows[i]);

    const titre = normalizeTitle(row[COL.TITRE]);
    if (!titre) continue;

    const saisonCell = parseInt(row[COL.SAISON], 10);
    const saison =
      Number.isNaN(saisonCell) || saisonCell <= 0
        ? inferSeasonFromTitle(titre)
        : saisonCell;

    const vus = row[COL.VUS];
    const oldDispo = row[COL.DISPO];
    const oldNbEpisode = row[COL.NB_EP];
    const oldMalId = row[COL.ID_MAL];
    const oldSlug = row[COL.SLUG];
    const oldImage = row[COL.IMAGE];

    console.log(`\n[${rowNumber}] ${titre} (saison ${saison})`);

    let malData = {
      malId: oldMalId,
      image: oldImage,
      nbEpisode: oldNbEpisode,
      saison,
    };

    try {
      malData = await getMalData(titre);
    } catch (error) {
      console.warn(`  MAL error: ${error.message}`);
    }

    await sleep(1000);

    let finalSlug = oldSlug;
    try {
      finalSlug = await resolveAnimeSamaSlug(oldSlug, titre, saison);
    } catch (error) {
      console.warn(`  Anime-Sama slug error: ${error.message}`);
    }

    const recentKey = `${finalSlug}__${saison}`;
    const recentEntry = recentEpisodesMap.get(recentKey);

    console.log(
      `[DEBUG] recherche récent avec key="${recentKey}" -> ${recentEntry ? `episode ${recentEntry.episode}` : "non trouvé"}`
    );

    const newDispo =
      recentEntry && recentEntry.episode
        ? recentEntry.episode
        : oldDispo;

    const newRow = [...row];

    newRow[COL.TITRE] = titre;
    newRow[COL.SAISON] = saison;
    newRow[COL.VUS] = vus;
    newRow[COL.DISPO] = newDispo;
    newRow[COL.NB_EP] =
      malData.nbEpisode !== "" ? malData.nbEpisode : oldNbEpisode;
    newRow[COL.ID_MAL] =
      malData.malId !== "" ? malData.malId : oldMalId;
    newRow[COL.SLUG] = finalSlug || oldSlug;
    newRow[COL.IMAGE] = malData.image || oldImage;

    const changed = JSON.stringify(newRow) !== JSON.stringify(row);

    if (!changed) {
      console.log("  No change.");
      continue;
    }

    await writeRow(rowNumber, newRow);
    console.log("  Updated.");
    console.log(`  Dispo: ${oldDispo} -> ${newRow[COL.DISPO]}`);
    console.log(`  nb_episode: ${oldNbEpisode} -> ${newRow[COL.NB_EP]}`);
    console.log(`  ID_MAL: ${oldMalId} -> ${newRow[COL.ID_MAL]}`);
    console.log(`  Slug: ${oldSlug} -> ${newRow[COL.SLUG]}`);

    await sleep(500);
  }

  console.log("\nDone.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
