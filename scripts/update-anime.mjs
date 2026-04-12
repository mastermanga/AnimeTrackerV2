import { google } from "googleapis";
import * as cheerio from "cheerio";

const SHEET_ID = process.env.SHEET_ID || "1WuGg-AH0X1x5ZdOswZlwn5KxE-V0TKeYTxovN20E9UE";
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
    headers: { "User-Agent": "anime-tracker-updater/1.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 anime-tracker-updater/1.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTitle(title) {
  return String(title || "").replace(/\s+/g, " ").trim();
}

// MISE À JOUR : Supporte maintenant les formats "4-3", "2-1", etc.
function inferSeasonFromTitle(title) {
  const t = normalizeTitle(title);
  const patterns = [
    /(?:^|\s)saison\s*([\d-]+)/i,
    /(?:^|\s)season\s*([\d-]+)/i,
    /(?:^|\s)s([\d-]+)/i,
    /(?:^|\s)([\d-]+)(?:nd|rd|th)?\s+season/i,
  ];

  for (const pattern of patterns) {
    const match = t.match(pattern);
    if (match) return match[1];
  }
  return "1";
}

function stripSeasonFromTitle(title) {
  return normalizeTitle(title)
    .replace(/(?:\s+[\d-].*?\s+season)$/i, "")
    .replace(/(?:\s+season\s+[\d-]+)$/i, "")
    .replace(/(?:\s+saison\s+[\d-]+)$/i, "")
    .replace(/(?:\s+s[\d-]+)$/i, "")
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
    const candidates = [item.title, item.title_english, ...(item.title_synonyms || [])]
      .filter(Boolean)
      .map(normalizeTitle);
    return candidates.includes(normalizeTitle(title));
  });
  return exact || list[0];
}

async function getMalData(rowTitle, forcedSaison) {
  const fullTitle = normalizeTitle(rowTitle);
  const baseTitle = stripSeasonFromTitle(fullTitle);

  let anime = await searchMalByTitle(fullTitle);
  await sleep(700);

  if (!anime && baseTitle !== fullTitle) {
    anime = await searchMalByTitle(baseTitle);
    await sleep(700);
  }

  if (!anime) {
    return { malId: "", image: "", nbEpisode: "", saison: forcedSaison };
  }

  return {
    malId: anime.mal_id ?? "",
    image: anime.images?.jpg?.image_url ?? "",
    nbEpisode: anime.episodes ?? "",
    saison: forcedSaison,
    malTitle: anime.title ?? fullTitle,
  };
}

async function resolveAnimeSamaSlug(existingSlug, title, saison) {
  if (existingSlug) {
    try {
      const url = buildAnimeSamaUrl(existingSlug, saison);
      const html = await fetchText(url);
      if (html && html.length > 1000) return existingSlug;
    } catch { /* ignore */ }
  }

  const candidate = slugifyForAnimeSama(title);
  try {
    const url = buildAnimeSamaUrl(candidate, saison);
    const html = await fetchText(url);
    if (html && html.length > 1000) return candidate;
  } catch { /* ignore */ }

  return existingSlug || candidate;
}

// MISE À JOUR : Supporte maintenant "saison 4-3 episode 12"
function extractSeasonEpisode(text) {
  const normalized = normalizeTitle(text);
  const match = normalized.match(/saison\s*([\d-]+)\s*episode\s*(\d+)/i);
  if (!match) return null;
  return { saison: match[1], episode: parseInt(match[2], 10) };
}

function extractSlugFromHref(href) {
  const match = (href || "").match(/\/catalogue\/([^/]+)\//i);
  return match ? match[1].trim() : "";
}

function extractVersionFromHref(href) {
  const norm = String(href || "").trim().toLowerCase();
  if (norm.endsWith("/vostfr/") || norm.endsWith("/vostfr")) return "vostfr";
  if (norm.endsWith("/vf/") || norm.endsWith("/vf")) return "vf";
  return "";
}

function extractRecentEpisodesFromHtml(html) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();
  const links = $('a[href*="/catalogue/"]');

  links.each((_, el) => {
    const link = $(el);
    const href = (link.attr("href") || "").trim();
    const slug = extractSlugFromHref(href);
    const text = normalizeTitle(link.text());
    const version = extractVersionFromHref(href);

    if (!slug || version !== "vostfr") return;

    const parsed = extractSeasonEpisode(text);
    if (!parsed) return;

    const key = `${slug}__${parsed.saison}__${version}`;
    if (seen.has(key)) return;
    seen.add(key);

    results.push({ ...parsed, slug, version });
  });
  return results;
}

async function getRecentEpisodesMap() {
  const html = await fetchText("https://anime-sama.to/");
  const recentEntries = extractRecentEpisodesFromHtml(html);
  const map = new Map();

  for (const entry of recentEntries) {
    const key = `${entry.slug}__${entry.saison}__${entry.version}`;
    const current = map.get(key);
    if (!current || entry.episode > current.episode) map.set(key, entry);
  }
  return map;
}

async function readSheetRows() {
  const range = `${SHEET_NAME}!A2:H`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
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
    requestBody: { values: [rowValues] },
  });
}

async function main() {
  console.log("=== SCRIPT START ===");
  const rows = await readSheetRows();
  let recentEpisodesMap = new Map();

  try {
    recentEpisodesMap = await getRecentEpisodesMap();
  } catch (e) {
    console.warn("Erreur Anime-Sama récents:", e.message);
  }

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 2;
    const row = padRow(rows[i]);
    const titre = normalizeTitle(row[COL.TITRE]);
    if (!titre) continue;

    // --- LOGIQUE SAISON ---
    // On garde la valeur brute du Google Sheet (ex: "4-3" ou "2")
    const saisonSheet = String(row[COL.SAISON] || "").trim();
    // On l'utilise, ou on l'infère si c'est vide
    const saisonCalcul = saisonSheet !== "" ? saisonSheet : inferSeasonFromTitle(titre);

    console.log(`\n[${rowNumber}] ${titre} (Saison: ${saisonCalcul})`);

    let malData = { malId: row[COL.ID_MAL], image: row[COL.IMAGE], nbEpisode: row[COL.NB_EP] };
    try {
      malData = await getMalData(titre, saisonCalcul);
    } catch (e) { console.warn(" MAL error:", e.message); }

    await sleep(800);

    let finalSlug = row[COL.SLUG];
    try {
      finalSlug = await resolveAnimeSamaSlug(row[COL.SLUG], titre, saisonCalcul);
    } catch (e) { console.warn(" Slug error:", e.message); }

    const recentKey = `${finalSlug}__${saisonCalcul}__vostfr`;
    const recentEntry = recentEpisodesMap.get(recentKey);
    const newDispo = recentEntry ? recentEntry.episode : row[COL.DISPO];

    const newRow = [...row];
    newRow[COL.TITRE] = titre;
    newRow[COL.SAISON] = row[COL.SAISON]; // STRICT : On ne modifie jamais la saison dans le Sheet
    newRow[COL.DISPO] = newDispo;
    newRow[COL.NB_EP] = malData.nbEpisode || row[COL.NB_EP];
    newRow[COL.ID_MAL] = malData.malId || row[COL.ID_MAL];
    newRow[COL.SLUG] = finalSlug || row[COL.SLUG];
    newRow[COL.IMAGE] = malData.image || row[COL.IMAGE];

    if (JSON.stringify(newRow) !== JSON.stringify(row)) {
      await writeRow(rowNumber, newRow);
      console.log(`  Updated: Dispo ${row[COL.DISPO]} -> ${newDispo}`);
    } else {
      console.log("  No change.");
    }
    await sleep(500);
  }
  console.log("\nDone.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
