function extractDispoFromHtml(html) {
  const $ = cheerio.load(html);

  const select = $("#selectEpisodes");
  console.log(`[DEBUG] #selectEpisodes trouvé: ${select.length > 0}`);

  const options = $("#selectEpisodes option");
  console.log(`[DEBUG] nombre d'options trouvées: ${options.length}`);

  const episodes = [];

  options.each((index, el) => {
    const text = $(el).text().trim();
    console.log(`[DEBUG] option ${index + 1}: "${text}"`);

    const match = text.match(/episode\s*(\d+)/i);

    if (match) {
      const n = parseInt(match[1], 10);
      console.log(`[DEBUG] épisode détecté: ${n}`);

      if (!Number.isNaN(n) && n > 0) {
        episodes.push(n);
      }
    } else {
      console.log(`[DEBUG] aucun numéro détecté dans: "${text}"`);
    }
  });

  console.log(`[DEBUG] épisodes extraits: ${JSON.stringify(episodes)}`);

  if (episodes.length === 0) {
    console.log("[DEBUG] aucun épisode trouvé, retour vide");
    return "";
  }

  const maxEpisode = Math.max(...episodes);
  console.log(`[DEBUG] dispo final retenu: ${maxEpisode}`);

  return maxEpisode;
}
