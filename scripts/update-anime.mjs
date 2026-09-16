import { google } from "googleapis";
import * as cheerio from "cheerio";

const SHEET_ID =
  process.env.SHEET_ID ||
  "1WuGg-AH0X1x5ZdOswZlwn5KxE-V0TKeYTxovN20E9UE";

const SHEET_NAME = process.env.SHEET_NAME || "Anime";

const GOOGLE_SERVICE_ACCOUNT_JSON =
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
  throw new Error(
    "Missing GOOGLE_SERVICE_ACCOUNT_JSON environment variable."
  );
}

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({
  version: "v4",
  auth,
});

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

/*
|--------------------------------------------------------------------------
| CONFIG RÉSEAU
|--------------------------------------------------------------------------
*/

const RETRYABLE_STATUS = new Set([
  429,
  500,
  502,
  503,
  504,
]);

// Nombre total de tentatives, première tentative comprise.
const MAX_RETRIES = 4;

// 2s -> 4s -> 8s entre les tentatives.
const RETRY_BASE_DELAY_MS = 2000;

// Timeout maximum d'un appel HTTP.
const REQUEST_TIMEOUT_MS = 20000;

// On espace les appels à Jikan.
const JIKAN_MIN_INTERVAL_MS = 1300;

let lastJikanRequestAt = 0;

/*
|--------------------------------------------------------------------------
| UTILITAIRES
|--------------------------------------------------------------------------
*/

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTitle(title) {
  return String(title || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isJikanUrl(url) {
  return String(url).startsWith("https://api.jikan.moe/");
}

async function waitForJikanSlot() {
  const elapsed = Date.now() - lastJikanRequestAt;

  if (elapsed < JIKAN_MIN_INTERVAL_MS) {
    await sleep(JIKAN_MIN_INTERVAL_MS - elapsed);
  }

  lastJikanRequestAt = Date.now();
}

function getRetryAfterMs(response) {
  const retryAfter = response.headers.get("retry-after");

  if (!retryAfter) {
    return null;
  }

  const seconds = Number(retryAfter);

  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(retryAfter);

  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }

  return null;
}

/*
|--------------------------------------------------------------------------
| FETCH AVEC RETRY AUTOMATIQUE
|--------------------------------------------------------------------------
*/

async function fetchWithRetry(
  url,
  {
    headers = {},
    responseType = "json",
    retries = MAX_RETRIES,
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = {}
) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (isJikanUrl(url)) {
      await waitForJikanSlot();
    }

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    let response;

    try {
      response = await fetch(url, {
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);

      if (attempt >= retries) {
        throw new Error(
          `Network error after ${attempt} attempts on ${url}: ${error.message}`
        );
      }

      const delay =
        RETRY_BASE_DELAY_MS *
        Math.pow(2, attempt - 1);

      console.warn(
        `  HTTP network error - tentative ${attempt}/${retries}. ` +
        `Nouvelle tentative dans ${delay / 1000}s...`
      );

      await sleep(delay);
      continue;
    }

    clearTimeout(timeout);

    if (response.ok) {
      if (responseType === "text") {
        return response.text();
      }

      return response.json();
    }

    const status = response.status;

    /*
     * Erreur non temporaire :
     * 400, 401, 403, 404...
     */
    if (!RETRYABLE_STATUS.has(status)) {
      throw new Error(
        `HTTP ${status} on ${url}`
      );
    }

    /*
     * Dernière tentative échouée.
     */
    if (attempt >= retries) {
      throw new Error(
        `HTTP ${status} after ${attempt} attempts on ${url}`
      );
    }

    const retryAfterMs =
      getRetryAfterMs(response);

    const exponentialDelay =
      RETRY_BASE_DELAY_MS *
      Math.pow(2, attempt - 1);

    const delay =
      retryAfterMs ?? exponentialDelay;

    console.warn(
      `  HTTP ${status} - tentative ${attempt}/${retries}. ` +
      `Nouvelle tentative dans ${Math.round(delay / 1000)}s...`
    );

    await sleep(delay);
  }

  throw new Error(
    `Impossible de récupérer ${url}`
  );
}

async function fetchJson(url) {
  return fetchWithRetry(url, {
    responseType: "json",
    headers: {
      "User-Agent":
        "anime-tracker-updater/2.0",
      Accept: "application/json",
    },
  });
}

async function fetchText(url) {
  return fetchWithRetry(url, {
    responseType: "text",
    headers: {
      "User-Agent":
        "Mozilla/5.0 anime-tracker-updater/2.0",
    },
  });
}

/*
|--------------------------------------------------------------------------
| SAISONS / TITRES
|--------------------------------------------------------------------------
*/

// Supporte "4-3", "2-1", etc.
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

    if (match) {
      return match[1];
    }
  }

  return "1";
}

function stripSeasonFromTitle(title) {
  return normalizeTitle(title)
    .replace(
      /(?:\s+[\d-].*?\s+season)$/i,
      ""
    )
    .replace(
      /(?:\s+season\s+[\d-]+)$/i,
      ""
    )
    .replace(
      /(?:\s+saison\s+[\d-]+)$/i,
      ""
    )
    .replace(
      /(?:\s+s[\d-]+)$/i,
      ""
    )
    .trim();
}

/*
|--------------------------------------------------------------------------
| ANIME-SAMA
|--------------------------------------------------------------------------
*/

function slugifyForAnimeSama(title) {
  return stripSeasonFromTitle(title)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildAnimeSamaUrl(
  slug,
  saison
) {
  return (
    `https://anime-sama.to/catalogue/` +
    `${slug}/saison${saison}/vostfr/`
  );
}

/*
|--------------------------------------------------------------------------
| JIKAN / MAL
|--------------------------------------------------------------------------
*/

async function getMalById(malId) {
  const id = String(malId || "").trim();

  if (!id) {
    return null;
  }

  const url =
    `https://api.jikan.moe/v4/anime/` +
    encodeURIComponent(id);

  const json = await fetchJson(url);

  return json?.data || null;
}

async function searchMalByTitle(title) {
  const q =
    encodeURIComponent(title);

  const url =
    `https://api.jikan.moe/v4/anime` +
    `?q=${q}&limit=5`;

  const json =
    await fetchJson(url);

  const list =
    Array.isArray(json.data)
      ? json.data
      : [];

  if (!list.length) {
    return null;
  }

  const normalizedRequestedTitle =
    normalizeTitle(title).toLowerCase();

  const exact = list.find((item) => {
    const candidates = [
      item.title,
      item.title_english,
      ...(item.title_synonyms || []),
    ]
      .filter(Boolean)
      .map((candidate) =>
        normalizeTitle(candidate)
          .toLowerCase()
      );

    return candidates.includes(
      normalizedRequestedTitle
    );
  });

  return exact || list[0];
}

async function getMalData(
  rowTitle,
  forcedSaison,
  existingMalId = ""
) {
  const fullTitle =
    normalizeTitle(rowTitle);

  const baseTitle =
    stripSeasonFromTitle(fullTitle);

  let anime = null;

  /*
   * PRIORITÉ 1 :
   * Si on connaît déjà l'ID MAL,
   * on évite une recherche texte.
   */
  if (existingMalId) {
    try {
      anime =
        await getMalById(
          existingMalId
        );

      if (anime) {
        console.log(
          `  MAL trouvé via ID ${existingMalId}`
        );
      }
    } catch (error) {
      console.warn(
        `  MAL ID ${existingMalId} indisponible : ${error.message}`
      );

      console.warn(
        "  Fallback vers recherche par titre..."
      );
    }
  }

  /*
   * PRIORITÉ 2 :
   * Recherche avec le titre complet.
   */
  if (!anime) {
    anime =
      await searchMalByTitle(
        fullTitle
      );
  }

  /*
   * PRIORITÉ 3 :
   * Recherche sans "Season X".
   */
  if (
    !anime &&
    baseTitle !== fullTitle
  ) {
    anime =
      await searchMalByTitle(
        baseTitle
      );
  }

  if (!anime) {
    return {
      malId: "",
      image: "",
      nbEpisode: "",
      saison: forcedSaison,
    };
  }

  return {
    malId:
      anime.mal_id ?? "",

    image:
      anime.images?.jpg?.image_url ??
      "",

    nbEpisode:
      anime.episodes ?? "",

    saison:
      forcedSaison,

    malTitle:
      anime.title ?? fullTitle,
  };
}

/*
|--------------------------------------------------------------------------
| RÉSOLUTION SLUG ANIME-SAMA
|--------------------------------------------------------------------------
*/

async function resolveAnimeSamaSlug(
  existingSlug,
  title,
  saison
) {
  if (existingSlug) {
    try {
      const url =
        buildAnimeSamaUrl(
          existingSlug,
          saison
        );

      const html =
        await fetchText(url);

      if (
        html &&
        html.length > 1000
      ) {
        return existingSlug;
      }
    } catch {
      // ignore
    }
  }

  const candidate =
    slugifyForAnimeSama(title);

  try {
    const url =
      buildAnimeSamaUrl(
        candidate,
        saison
      );

    const html =
      await fetchText(url);

    if (
      html &&
      html.length > 1000
    ) {
      return candidate;
    }
  } catch {
    // ignore
  }

  return (
    existingSlug ||
    candidate
  );
}

/*
|--------------------------------------------------------------------------
| ÉPISODES RÉCENTS ANIME-SAMA
|--------------------------------------------------------------------------
*/

// Supporte "saison 4-3 episode 12"
function extractSeasonEpisode(text) {
  const normalized =
    normalizeTitle(text);

  const match =
    normalized.match(
      /saison\s*([\d-]+)\s*episode\s*(\d+)/i
    );

  if (!match) {
    return null;
  }

  return {
    saison: match[1],
    episode: parseInt(
      match[2],
      10
    ),
  };
}

function extractSlugFromHref(href) {
  const match =
    (href || "").match(
      /\/catalogue\/([^/]+)\//i
    );

  return match
    ? match[1].trim()
    : "";
}

function extractVersionFromHref(href) {
  const norm =
    String(href || "")
      .trim()
      .toLowerCase();

  if (
    norm.endsWith("/vostfr/") ||
    norm.endsWith("/vostfr")
  ) {
    return "vostfr";
  }

  if (
    norm.endsWith("/vf/") ||
    norm.endsWith("/vf")
  ) {
    return "vf";
  }

  return "";
}

function extractRecentEpisodesFromHtml(
  html
) {
  const $ =
    cheerio.load(html);

  const results = [];

  const seen =
    new Set();

  const links =
    $('a[href*="/catalogue/"]');

  links.each((_, el) => {
    const link =
      $(el);

    const href =
      (
        link.attr("href") ||
        ""
      ).trim();

    const slug =
      extractSlugFromHref(
        href
      );

    const text =
      normalizeTitle(
        link.text()
      );

    const version =
      extractVersionFromHref(
        href
      );

    if (
      !slug ||
      version !== "vostfr"
    ) {
      return;
    }

    const parsed =
      extractSeasonEpisode(
        text
      );

    if (!parsed) {
      return;
    }

    const key =
      `${slug}__` +
      `${parsed.saison}__` +
      `${version}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    results.push({
      ...parsed,
      slug,
      version,
    });
  });

  return results;
}

async function getRecentEpisodesMap() {
  const html =
    await fetchText(
      "https://anime-sama.to/"
    );

  const recentEntries =
    extractRecentEpisodesFromHtml(
      html
    );

  const map =
    new Map();

  for (
    const entry of recentEntries
  ) {
    const key =
      `${entry.slug}__` +
      `${entry.saison}__` +
      `${entry.version}`;

    const current =
      map.get(key);

    if (
      !current ||
      entry.episode >
        current.episode
    ) {
      map.set(
        key,
        entry
      );
    }
  }

  return map;
}

/*
|--------------------------------------------------------------------------
| GOOGLE SHEETS
|--------------------------------------------------------------------------
*/

async function readSheetRows() {
  const range =
    `${SHEET_NAME}!A2:H`;

  const res =
    await sheets.spreadsheets.values.get({
      spreadsheetId:
        SHEET_ID,
      range,
    });

  return (
    res.data.values ||
    []
  );
}

function padRow(row) {
  const copy =
    [...row];

  while (
    copy.length < 8
  ) {
    copy.push("");
  }

  return copy;
}

async function writeRow(
  rowIndex,
  rowValues
) {
  const range =
    `${SHEET_NAME}!A${rowIndex}:H${rowIndex}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId:
      SHEET_ID,

    range,

    valueInputOption:
      "USER_ENTERED",

    requestBody: {
      values: [
        rowValues,
      ],
    },
  });
}

/*
|--------------------------------------------------------------------------
| MAIN
|--------------------------------------------------------------------------
*/

async function main() {
  console.log(
    "=== SCRIPT START ==="
  );

  const rows =
    await readSheetRows();

  console.log(
    `${rows.length} anime(s) à vérifier.`
  );

  let recentEpisodesMap =
    new Map();

  try {
    recentEpisodesMap =
      await getRecentEpisodesMap();

    console.log(
      `Anime-Sama : ${recentEpisodesMap.size} entrée(s) récente(s) récupérée(s).`
    );
  } catch (error) {
    console.warn(
      "Erreur Anime-Sama récents:",
      error.message
    );
  }

  for (
    let i = 0;
    i < rows.length;
    i++
  ) {
    const rowNumber =
      i + 2;

    const row =
      padRow(rows[i]);

    const titre =
      normalizeTitle(
        row[COL.TITRE]
      );

    if (!titre) {
      continue;
    }

    /*
     * SAISON
     */
    const saisonSheet =
      String(
        row[COL.SAISON] ||
        ""
      ).trim();

    const saisonCalcul =
      saisonSheet !== ""
        ? saisonSheet
        : inferSeasonFromTitle(
            titre
          );

    console.log(
      `\n[${rowNumber}] ${titre} (Saison: ${saisonCalcul})`
    );

    /*
     * MAL / JIKAN
     */
    let malData = {
      malId:
        row[COL.ID_MAL],

      image:
        row[COL.IMAGE],

      nbEpisode:
        row[COL.NB_EP],
    };

    try {
      malData =
        await getMalData(
          titre,
          saisonCalcul,
          row[COL.ID_MAL]
        );
    } catch (error) {
      console.warn(
        "  Jikan/MAL error:",
        error.message
      );
    }

    /*
     * Petit délai de sécurité.
     */
    await sleep(500);

    /*
     * ANIME-SAMA SLUG
     */
    let finalSlug =
      row[COL.SLUG];

    try {
      finalSlug =
        await resolveAnimeSamaSlug(
          row[COL.SLUG],
          titre,
          saisonCalcul
        );
    } catch (error) {
      console.warn(
        "  Slug error:",
        error.message
      );
    }

    /*
     * ÉPISODE DISPONIBLE
     */
    const recentKey =
      `${finalSlug}__` +
      `${saisonCalcul}__` +
      `vostfr`;

    const recentEntry =
      recentEpisodesMap.get(
        recentKey
      );

    const newDispo =
      recentEntry
        ? recentEntry.episode
        : row[COL.DISPO];

    /*
     * NOUVELLE LIGNE
     */
    const newRow =
      [...row];

    newRow[COL.TITRE] =
      titre;

    /*
     * IMPORTANT :
     * la saison du Sheet
     * n'est jamais modifiée.
     */
    newRow[COL.SAISON] =
      row[COL.SAISON];

    newRow[COL.DISPO] =
      newDispo;

    newRow[COL.NB_EP] =
      malData.nbEpisode ||
      row[COL.NB_EP];

    newRow[COL.ID_MAL] =
      malData.malId ||
      row[COL.ID_MAL];

    newRow[COL.SLUG] =
      finalSlug ||
      row[COL.SLUG];

    newRow[COL.IMAGE] =
      malData.image ||
      row[COL.IMAGE];

    /*
     * ÉCRITURE SEULEMENT
     * SI QUELQUE CHOSE CHANGE
     */
    if (
      JSON.stringify(newRow) !==
      JSON.stringify(row)
    ) {
      await writeRow(
        rowNumber,
        newRow
      );

      console.log(
        `  Updated: Dispo ${row[COL.DISPO]} -> ${newDispo}`
      );
    } else {
      console.log(
        "  No change."
      );
    }

    await sleep(500);
  }

  console.log(
    "\nDone."
  );
}

main().catch((error) => {
  console.error(
    "Fatal error:",
    error
  );

  process.exit(1);
});
