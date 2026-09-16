import { google } from "googleapis";
import * as cheerio from "cheerio";

const SHEET_ID =
  process.env.SHEET_ID ||
  "1WuGg-AH0X1x5ZdOswZlwn5KxE-V0TKeYTxovN20E9UE";

const SHEET_NAME = process.env.SHEET_NAME || "Anime";

const GOOGLE_SERVICE_ACCOUNT_JSON =
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

const MAL_CLIENT_ID =
  process.env.MAL_CLIENT_ID;

if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
  throw new Error(
    "Missing GOOGLE_SERVICE_ACCOUNT_JSON environment variable."
  );
}

if (!MAL_CLIENT_ID) {
  throw new Error(
    "Missing MAL_CLIENT_ID environment variable."
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

const MAX_RETRIES = 4;

const RETRY_BASE_DELAY_MS = 2000;

const REQUEST_TIMEOUT_MS = 20000;

/*
 * Petit délai entre les appels MAL.
 */
const MAL_MIN_INTERVAL_MS = 500;

let lastMalRequestAt = 0;

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

function isMalUrl(url) {
  return String(url).startsWith(
    "https://api.myanimelist.net/"
  );
}

async function waitForMalSlot() {
  const elapsed =
    Date.now() - lastMalRequestAt;

  if (elapsed < MAL_MIN_INTERVAL_MS) {
    await sleep(
      MAL_MIN_INTERVAL_MS - elapsed
    );
  }

  lastMalRequestAt = Date.now();
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

  const date =
    Date.parse(retryAfter);

  if (Number.isFinite(date)) {
    return Math.max(
      0,
      date - Date.now()
    );
  }

  return null;
}

/*
|--------------------------------------------------------------------------
| FETCH AVEC RETRY
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
  for (
    let attempt = 1;
    attempt <= retries;
    attempt++
  ) {
    if (isMalUrl(url)) {
      await waitForMalSlot();
    }

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

    const status =
      response.status;

    /*
     * 400 / 401 / 403 / 404...
     * => pas de retry automatique.
     */
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
      `Nouvelle tentative dans ${Math.round(delay / 1000)}s...`
    );

    await sleep(delay);
  }

  throw new Error(
    `Impossible de récupérer ${url}`
  );
}

/*
|--------------------------------------------------------------------------
| API MYANIMELIST OFFICIELLE
|--------------------------------------------------------------------------
*/

async function fetchMalJson(url) {
  return fetchWithRetry(url, {
    responseType: "json",
    headers: {
      "X-MAL-CLIENT-ID":
        MAL_CLIENT_ID,
      Accept:
        "application/json",
      "User-Agent":
        "anime-tracker-updater/3.0",
    },
  });
}

/*
|--------------------------------------------------------------------------
| ANIME-SAMA FETCH
|--------------------------------------------------------------------------
*/

async function fetchText(url) {
  return fetchWithRetry(url, {
    responseType: "text",
    headers: {
      "User-Agent":
        "Mozilla/5.0 anime-tracker-updater/3.0",
    },
  });
}

/*
|--------------------------------------------------------------------------
| SAISONS / TITRES
|--------------------------------------------------------------------------
*/

function inferSeasonFromTitle(title) {
  const t =
    normalizeTitle(title);

  const patterns = [
    /(?:^|\s)saison\s*([\d-]+)/i,
    /(?:^|\s)season\s*([\d-]+)/i,
    /(?:^|\s)s([\d-]+)/i,
    /(?:^|\s)([\d-]+)(?:nd|rd|th)?\s+season/i,
  ];

  for (const pattern of patterns) {
    const match =
      t.match(pattern);

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
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(
      /[^a-z0-9]+/g,
      "-"
    )
    .replace(
      /^-+|-+$/g,
      ""
    );
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
| MAL
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

/*
 * Récupération directe grâce à l'ID MAL
 * présent dans le Google Sheet.
 */
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

/*
 * Recherche MAL uniquement si aucun ID
 * exploitable n'est disponible.
 */
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
        .map((candidate) =>
          normalizeTitle(candidate)
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
  forcedSaison,
  existingMalId = ""
) {
  const fullTitle =
    normalizeTitle(rowTitle);

  const baseTitle =
    stripSeasonFromTitle(
      fullTitle
    );

  let anime = null;

  /*
   * PRIORITÉ 1
   *
   * L'ID MAL existe déjà dans le Sheet.
   * On récupère directement la fiche.
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
   * PRIORITÉ 2
   *
   * Recherche titre complet.
   */
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

  /*
   * PRIORITÉ 3
   *
   * Exemple :
   * "Re:Zero Season 4"
   * devient éventuellement
   * "Re:Zero"
   */
  if (
    !anime &&
    baseTitle !== fullTitle
  ) {
    anime =
      await searchMalByTitle(
        baseTitle
      );

    if (anime) {
      console.log(
        `  MAL trouvé via titre alternatif : ${anime.title} (ID ${anime.id})`
      );
    }
  }

  if (!anime) {
    return {
      malId: "",
      image: "",
      nbEpisode: "",
      saison: forcedSaison,
    };
  }

  /*
   * MAL peut retourner 0 pour une série
   * pas encore diffusée / nombre inconnu.
   * Dans ce cas on laisse vide.
   */
  const nbEpisode =
    Number(anime.num_episodes) > 0
      ? anime.num_episodes
      : "";

  const image =
    anime.main_picture?.large ||
    anime.main_picture?.medium ||
    "";

  return {
    malId:
      anime.id ?? "",

    image,

    nbEpisode,

    saison:
      forcedSaison,

    malTitle:
      anime.title ??
      fullTitle,
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
  /*
   * Si le slug du Sheet fonctionne,
   * on le garde.
   */
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
      // Ignore
    }
  }

  /*
   * Sinon on tente un slug automatique.
   */
  const candidate =
    slugifyForAnimeSama(
      title
    );

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
    // Ignore
  }

  /*
   * Si Anime-Sama n'a pas encore
   * la série, on conserve quand même
   * le slug existant / candidat.
   */
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
    saison:
      match[1],

    episode:
      parseInt(
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

  /*
   * Récupération des épisodes
   * récents Anime-Sama.
   */
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

  /*
   * Parcours du Sheet.
   */
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
     *
     * On garde exactement la valeur
     * du Sheet :
     *
     * 4
     * 2
     * 2-4
     * etc.
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
     * MAL
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
        "  MAL error:",
        error.message
      );
    }

    /*
     * Petit délai.
     */
    await sleep(300);

    /*
     * SLUG ANIME-SAMA
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

    /*
     * IMPORTANT :
     *
     * Si l'anime n'est pas encore
     * sur Anime-Sama, on conserve
     * la valeur du Sheet.
     *
     * Donc 0 reste 0.
     */
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
     * On ne modifie jamais
     * automatiquement la saison.
     */
    newRow[COL.SAISON] =
      row[COL.SAISON];

    newRow[COL.DISPO] =
      newDispo;

    /*
     * Si MAL ne connaît pas encore
     * le nombre d'épisodes,
     * on conserve l'ancienne valeur.
     */
    newRow[COL.NB_EP] =
      malData.nbEpisode ||
      row[COL.NB_EP];

    /*
     * ID MAL
     */
    newRow[COL.ID_MAL] =
      malData.malId ||
      row[COL.ID_MAL];

    /*
     * Anime-Sama slug
     */
    newRow[COL.SLUG] =
      finalSlug ||
      row[COL.SLUG];

    /*
     * Image MAL
     */
    newRow[COL.IMAGE] =
      malData.image ||
      row[COL.IMAGE];

    /*
     * On écrit uniquement
     * si quelque chose change.
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

    await sleep(300);
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
