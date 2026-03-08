import { google } from "googleapis";
import * as cheerio from "cheerio";

const SHEET_ID = process.env.SHEET_ID || "1WuGg-AH0X1x5ZdOswZlwn5KxE-V0TKeYTxovN20E9UE";
const SHEET_NAME = process.env.SHEET_NAME || "Anime";
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.AnimeTrackerSecretAccountJsonGoogleService;

if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
  throw new Error(
    "Missing AnimeTrackerSecretAccountJsonGoogleService environment variable."
  );
}

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

const COL = {
  TITRE: 0,      // A
  SAISON: 1,     // B
  VUS: 2,        // C
  DISPO: 3,      // D
  NB_EP: 4,      // E
  ID_MAL: 5,     // F
  SLUG: 6,       // G
  IMAGE: 7,      // H
};

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "anime-tracker-updater/1.0"
    }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${url}`);
  }

  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 anime-tracker-updater/1.0"
    }
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
  return String(title || "")
    .replace(/\s+/g, " ")
    .trim();
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

function buildAnimeSamaUrl(slug, saison) {
  return `https://anime-sama.to/catalogue/${slug}/saison${saison}/vostfr/`;
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

async function resolveAnimeSamaSlug(existingSlug, title, saison) {
  if (existingSlug) {
    try {
      const url = buildAnimeSamaUrl(existingSlug, saison);
      const html = await fetchText(url);
      if (html && html.length > 1000) return existingSlug;
    } catch {
      // continue
    }
  }

  const candidate = slugifyForAnimeSama(title);
  try {
    const url = buildAnimeSamaUrl(candidate, saison);
    const html = await fetchText(url);
    if (html && html.length > 1000) return candidate;
  } catch {
    // continue
  }

  return existingSlug || candidate;
}

function extractDispoFromHtml(html) {
  const $ = cheerio.load(html);

  const numericOptions = [];
  $("select option").each((_, el) => {
    const txt = $(el).text().trim();
    const match = txt.match(/\b(\d{1,4})\b/);
    if (match) numericOptions.push(parseInt(match[1], 10));
  });

  if (numericOptions.length) {
    return Math.max(...numericOptions);
  }

  const scriptText = $("script")
    .map((_, el) => $(el).html() || "")
    .get()
    .join("\n");

  const allEpisodeNumbers = [];

  for (const regex of [
    /episode[^0-9]{0,20}(\d{1,4})/gi,
    /ep[^0-9]{0,20}(\d{1,4})/gi,
    /["'`](\d{1,4})["'`]/g,
  ]) {
    let match;
    while ((match = regex.exec(scriptText)) !== null) {
      const n = parseInt(match[1], 10);
      if (!Number.isNaN(n) && n > 0 && n < 5000) {
        allEpisodeNumbers.push(n);
      }
    }
  }

  if (allEpisodeNumbers.length) {
    return Math.max(...allEpisodeNumbers);
  }

  return "";
}

async function getAnimeSamaData(title, saison, existingSlug) {
  const slug = await resolveAnimeSamaSlug(existingSlug, title, saison);

  try {
    const url = buildAnimeSamaUrl(slug, saison);
    const html = await fetchText(url);
    const dispo = extractDispoFromHtml(html);

    return {
      slug,
      dispo,
      animeSamaUrl: url,
    };
  } catch (error) {
    return {
      slug,
      dispo: "",
      animeSamaUrl: buildAnimeSamaUrl(slug, saison),
      error: error.message,
    };
  }
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
  console.log("Reading sheet...");
  const rows = await readSheetRows();
  console.log(`Found ${rows.length} anime rows.`);

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 2;
    const row = padRow(rows[i]);

    const titre = normalizeTitle(row[COL.TITRE]);
    if (!titre) continue;

    const saisonCell = parseInt(row[COL.SAISON], 10);
    const saison = Number.isNaN(saisonCell) || saisonCell <= 0
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

    let animeSamaData = {
      slug: oldSlug,
      dispo: oldDispo,
    };

    try {
      malData = await getMalData(titre);
    } catch (error) {
      console.warn(`  MAL error: ${error.message}`);
    }

    await sleep(1000);

    try {
      animeSamaData = await getAnimeSamaData(
        titre,
        saison,
        oldSlug
      );
    } catch (error) {
      console.warn(`  Anime-Sama error: ${error.message}`);
    }

    const newRow = [...row];

    newRow[COL.TITRE] = titre; // on garde ton titre actuel comme clé stable
    newRow[COL.SAISON] = saison;
    newRow[COL.VUS] = vus; // on n’y touche jamais
    newRow[COL.DISPO] =
      animeSamaData.dispo !== "" ? animeSamaData.dispo : oldDispo;
    newRow[COL.NB_EP] =
      malData.nbEpisode !== "" ? malData.nbEpisode : oldNbEpisode;
    newRow[COL.ID_MAL] =
      malData.malId !== "" ? malData.malId : oldMalId;
    newRow[COL.SLUG] =
      animeSamaData.slug || oldSlug;
    newRow[COL.IMAGE] =
      malData.image || oldImage;

    const changed =
      JSON.stringify(newRow) !== JSON.stringify(row);

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
