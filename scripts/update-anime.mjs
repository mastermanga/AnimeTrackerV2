import { google } from "googleapis";
import * as cheerio from "cheerio";

const SHEET_ID =
  process.env.SHEET_ID ||
  "1WuGg-AH0X1x5ZdOswZlwn5KxE-V0TKeYTxovN20E9UE";

const SHEET_NAME = process.env.SHEET_NAME || "Anime";

const GOOGLE_SERVICE_ACCOUNT_JSON =
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

const MAL_CLIENT_ID = process.env.MAL_CLIENT_ID;

const RUN_MAL =
  String(process.env.RUN_MAL || "false").toLowerCase() === "true";

if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
  throw new Error(
    "Missing GOOGLE_SERVICE_ACCOUNT_JSON environment variable."
  );
}

if (RUN_MAL && !MAL_CLIENT_ID) {
  throw new Error(
    "RUN_MAL=true mais MAL_CLIENT_ID est manquant."
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

const RETRYABLE_STATUS = new Set([
  429,
  500,
  502,
  503,
  504,
]);

const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 20000;

const MAL_MIN_INTERVAL_MS = 500;
const ANIME_SAMA_MIN_INTERVAL_MS = 400;

let lastMalRequestAt = 0;
let lastAnimeSamaRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTitle(title) {
  return String(title || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAnimeSamaSeason(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^saison\s*/i, "")
    .replace(/\s+/g, "");
}

function slugifyForAnimeSama(title) {
  return normalizeTitle(title)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildAnimeSamaUrl(slug, saison) {
  const cleanSeason = normalizeAnimeSamaSeason(saison);

  return (
    `https://anime-sama.to/catalogue/` +
    `${slug}/saison${cleanSeason}/vostfr/`
  );
}

function isMalUrl(url) {
  return String(url).startsWith(
    "https://api.myanimelist.net/"
  );
}

function isAnimeSamaUrl(url) {
  try {
    return new URL(url).hostname === "anime-sama.to";
  } catch {
    return false;
  }
}

async function waitForRequestSlot(url) {
  if (isMalUrl(url)) {
    const elapsed =
      Date.now() - lastMalRequestAt;

    if (elapsed < MAL_MIN_INTERVAL_MS) {
      await sleep(
        MAL_MIN_INTERVAL_MS - elapsed
      );
    }

    lastMalRequestAt = Date.now();
    return;
  }

  if (isAnimeSamaUrl(url)) {
    const elapsed =
      Date.now() - lastAnimeSamaRequestAt;

    if (elapsed < ANIME_SAMA_MIN_INTERVAL_MS) {
      await sleep(
        ANIME_SAMA_MIN_INTERVAL_MS - elapsed
      );
    }

    lastAnimeSamaRequestAt = Date.now();
  }
}

function getRetryAfterMs(response) {
  const retryAfter =
    response.headers.get("retry-after");

  if (!retryAfter) {
    return null;
  }

  const seconds = Number(retryAfter);

  if (Number.isFinite(seconds)) {
    return Math.max(
      0,
      seconds * 1000
    );
  }

  const date = Date.parse(retryAfter);

  if (Number.isFinite(date)) {
    return Math.max(
      0,
      date - Date.now()
    );
  }

  return null;
}

async function fetchWithRetry(
  url,
  {
    headers = {},
    responseType = "json",
    retries = MAX_RETRIES,
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = {}
) {
  for (
    let attempt = 1;
    attempt <= retries;
    attempt++
  ) {
    await waitForRequestSlot(url);

    const controller =
      new AbortController();

    const timeout =
      setTimeout(() => {
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
        `  Erreur réseau - tentative ${attempt}/${retries}. ` +
        `Retry dans ${delay / 1000}s...`
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

    const status =
      response.status;

    if (!RETRYABLE_STATUS.has(status)) {
      throw new Error(
        `HTTP ${status} on ${url}`
      );
    }

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
      retryAfterMs ??
      exponentialDelay;

    console.warn(
      `  HTTP ${status} - tentative ${attempt}/${retries}. ` +
      `Retry dans ${Math.round(delay / 1000)}s...`
    );

    await sleep(delay);
  }

  throw new Error(
    `Impossible de récupérer ${url}`
  );
}

async function fetchMalJson(url) {
  return fetchWithRetry(url, {
    responseType: "json",
    headers: {
      "X-MAL-CLIENT-ID":
        MAL_CLIENT_ID,

      Accept:
        "application/json",

      "User-Agent":
        "anime-tracker-updater/4.0",
    },
  });
}

async function fetchAnimeSamaText(
  url,
  referer = "https://anime-sama.to/"
) {
  return fetchWithRetry(url, {
    responseType: "text",
    headers: {
      Accept:
        "text/html,application/xhtml+xml,application/javascript,*/*;q=0.8",

      "Accept-Language":
        "fr-FR,fr;q=0.9,en;q=0.8",

      Referer:
        referer,

      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 Chrome/138 Safari/537.36",
    },
  });
}

/*
|--------------------------------------------------------------------------
| MYANIMELIST
|--------------------------------------------------------------------------
*/

const MAL_FIELDS = [
  "id",
  "title",
  "main_picture",
  "alternative_titles",
  "num_episodes",
  "status",
].join(",");

async function getMalById(malId) {
  const id =
    String(malId || "").trim();

  if (!id) {
    return null;
  }

  const url =
    `https://api.myanimelist.net/v2/anime/` +
    `${encodeURIComponent(id)}` +
    `?fields=${encodeURIComponent(MAL_FIELDS)}`;

  return fetchMalJson(url);
}

async function searchMalByTitle(title) {
  const url =
    `https://api.myanimelist.net/v2/anime` +
    `?q=${encodeURIComponent(title)}` +
    `&limit=5` +
    `&fields=${encodeURIComponent(MAL_FIELDS)}`;

  const json =
    await fetchMalJson(url);

  const list =
    Array.isArray(json.data)
      ? json.data
          .map((item) => item.node)
          .filter(Boolean)
      : [];

  if (!list.length) {
    return null;
  }

  const requested =
    normalizeTitle(title)
      .toLowerCase();

  const exact =
    list.find((anime) => {
      const alternatives =
        anime.alternative_titles || {};

      const candidates = [
        anime.title,
        alternatives.en,
        alternatives.ja,
        ...(alternatives.synonyms || []),
      ]
        .filter(Boolean)
        .map((value) =>
          normalizeTitle(value)
            .toLowerCase()
        );

      return candidates.includes(
        requested
      );
    });

  return exact || list[0];
}

async function getMalData(
  rowTitle,
  existingMalId = ""
) {
  const fullTitle =
    normalizeTitle(rowTitle);

  let anime = null;

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
    }
  }

  if (!anime) {
    anime =
      await searchMalByTitle(
        fullTitle
      );

    if (anime) {
      console.log(
        `  MAL trouvé par titre : ${anime.title} (ID ${anime.id})`
      );
    }
  }

  if (!anime) {
    return null;
  }

  return {
    malId:
      anime.id ?? "",

    image:
      anime.main_picture?.large ||
      anime.main_picture?.medium ||
      "",

    nbEpisode:
      Number(anime.num_episodes) > 0
        ? anime.num_episodes
        : "",
  };
}

/*
|--------------------------------------------------------------------------
| ANIME-SAMA
|--------------------------------------------------------------------------
*/

function countArrayItems(arrayBody) {
  const quotedItems =
    arrayBody.match(
      /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g
    );

  return quotedItems
    ? quotedItems.length
    : 0;
}

function extractEpisodeCountFromEpisodesJs(
  jsText
) {
  const arrayRegex =
    /(?:var|let|const)\s+(eps\d+)\s*=\s*\[([\s\S]*?)\]\s*;/g;

  let match;
  let maxEpisodes = 0;

  while (
    (match = arrayRegex.exec(jsText)) !== null
  ) {
    const count =
      countArrayItems(
        match[2]
      );

    if (count > maxEpisodes) {
      maxEpisodes = count;
    }
  }

  return maxEpisodes;
}

function extractEpisodeCountFromPage(
  html
) {
  const $ =
    cheerio.load(html);

  let maxEpisode = 0;

  $("option").each((_, el) => {
    const text =
      normalizeTitle(
        $(el).text()
      );

    const match =
      text.match(
        /episode\s*(\d+)/i
      );

    if (match) {
      maxEpisode =
        Math.max(
          maxEpisode,
          Number(match[1])
        );
    }
  });

  const pageText =
    normalizeTitle(
      $.root().text()
    );

  const lastSelection =
    pageText.match(
      /derni[eè]re\s+s[ée]lection\s*:\s*episode\s*(\d+)/i
    );

  if (lastSelection) {
    maxEpisode =
      Math.max(
        maxEpisode,
        Number(lastSelection[1])
      );
  }

  return maxEpisode;
}

async function getAnimeSamaAvailableEpisodes(
  slug,
  saison
) {
  const cleanSlug =
    String(slug || "").trim();

  const cleanSeason =
    normalizeAnimeSamaSeason(
      saison
    );

  if (
    !cleanSlug ||
    !cleanSeason
  ) {
    return null;
  }

  const pageUrl =
    buildAnimeSamaUrl(
      cleanSlug,
      cleanSeason
    );

  const html =
    await fetchAnimeSamaText(
      pageUrl
    );

  const $ =
    cheerio.load(html);

  let detected =
    extractEpisodeCountFromPage(
      html
    );

  const scriptSrc =
    $("script[src]")
      .map(
        (_, el) =>
          $(el).attr("src") || ""
      )
      .get()
      .find(
        (src) =>
          /episodes\.js/i.test(src)
      );

  if (scriptSrc) {
    const jsUrl =
      new URL(
        scriptSrc,
        pageUrl
      ).href;

    const jsText =
      await fetchAnimeSamaText(
        jsUrl,
        pageUrl
      );

    detected =
      Math.max(
        detected,
        extractEpisodeCountFromEpisodesJs(
          jsText
        )
      );
  }

  if (
    !scriptSrc &&
    detected === 0
  ) {
    throw new Error(
      `episodes.js introuvable sur ${pageUrl}`
    );
  }

  return detected;
}

function shouldSkipAnimeSama(row) {
  const dispo =
    Number.parseInt(
      row[COL.DISPO],
      10
    );

  const total =
    Number.parseInt(
      row[COL.NB_EP],
      10
    );

  return (
    Number.isFinite(dispo) &&
    Number.isFinite(total) &&
    total > 0 &&
    dispo >= total
  );
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

  console.log(
    `MAL aujourd'hui : ${RUN_MAL ? "OUI" : "NON"}`
  );

  const rows =
    await readSheetRows();

  console.log(
    `${rows.length} anime(s) à vérifier.`
  );

  for (
    let i = 0;
    i < rows.length;
    i++
  ) {
    const rowNumber =
      i + 2;

    const row =
      padRow(
        rows[i]
      );

    const titre =
      normalizeTitle(
        row[COL.TITRE]
      );

    if (!titre) {
      continue;
    }

    /*
     * SAISON 100 % MANUELLE
     *
     * Exemples :
     * 3
     * 2-4
     * 1part1
     * saison1part1
     */
    const saison =
      normalizeAnimeSamaSeason(
        row[COL.SAISON]
      );

    /*
     * Le slug du Sheet reste prioritaire.
     * Si vide, on tente d'en générer un.
     */
    const finalSlug =
      String(
        row[COL.SLUG] ||
        ""
      ).trim() ||
      slugifyForAnimeSama(
        titre
      );

    console.log(
      `\n[${rowNumber}] ${titre} (Saison: ${saison || "VIDE"})`
    );

    const newRow =
      [...row];

    newRow[COL.TITRE] =
      titre;

    /*
     * IMPORTANT :
     * la saison n'est jamais changée
     * automatiquement.
     */
    newRow[COL.SAISON] =
      row[COL.SAISON];

    newRow[COL.SLUG] =
      finalSlug;

    /*
     * MAL
     * Seulement lorsque RUN_MAL=true.
     */
    if (RUN_MAL) {
      try {
        const malData =
          await getMalData(
            titre,
            row[COL.ID_MAL]
          );

        if (malData) {
          newRow[COL.NB_EP] =
            malData.nbEpisode ||
            row[COL.NB_EP];

          newRow[COL.ID_MAL] =
            malData.malId ||
            row[COL.ID_MAL];

          newRow[COL.IMAGE] =
            malData.image ||
            row[COL.IMAGE];
        }
      } catch (error) {
        console.warn(
          `  MAL error: ${error.message}`
        );
      }
    }

    /*
     * ANIME-SAMA
     */
    if (!saison) {
      console.warn(
        "  Anime-Sama ignoré : colonne Saison vide."
      );
    } else if (
      shouldSkipAnimeSama(
        newRow
      )
    ) {
      console.log(
        "  Anime-Sama ignoré : tous les épisodes sont déjà disponibles."
      );
    } else {
      try {
        const detected =
          await getAnimeSamaAvailableEpisodes(
            finalSlug,
            saison
          );

        const currentDispo =
          Number.parseInt(
            row[COL.DISPO],
            10
          ) || 0;

        if (
          Number.isFinite(
            detected
          )
        ) {
          /*
           * Sécurité :
           * DISPO ne descend jamais.
           */
          const newDispo =
            Math.max(
              currentDispo,
              detected
            );

          newRow[COL.DISPO] =
            newDispo;

          console.log(
            `  Anime-Sama : ${detected} épisode(s) détecté(s).`
          );
        }
      } catch (error) {
        console.warn(
          `  Anime-Sama error: ${error.message}`
        );
      }
    }

    /*
     * Écriture uniquement si changement.
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
        `  Updated: Dispo ${row[COL.DISPO] || 0} -> ${newRow[COL.DISPO] || 0}`
      );
    } else {
      console.log(
        "  No change."
      );
    }
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
