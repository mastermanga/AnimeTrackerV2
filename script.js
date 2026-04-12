const sheetUrl =
  "https://docs.google.com/spreadsheets/d/1WuGg-AH0X1x5ZdOswZlwn5KxE-V0TKeYTxovN20E9UE/export?format=csv&gid=15026583";

const updateUrl =
  "https://script.google.com/macros/s/AKfycby-V1gcNKBdN7Lt2HqdrwdyzNfdVJO8m_mAeXoGRIWSO0AHBFE0c2ac-bP9krEa_A/exec";

async function loadAnime() {
  try {
    const res = await fetch(sheetUrl, { cache: "no-store" });
    const data = await res.text();

    // On sépare les lignes et on retire l'en-tête
    const rows = data.trim().split("\n").slice(1);

    const animeData = rows.map((row) => {
      /**
       * On utilise une expression régulière pour splitter par virgule, 
       * mais en ignorant les virgules situées à l'intérieur de guillemets (titres avec virgules).
       */
      const columns = row.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
      
      const [titre, saison, vus, dispo, nb_episode, id_mal, slug, image_url] = columns;

      return {
        titre: (titre || "").replace(/^"|"$/g, "").trim(),
        // MODIFICATION : On garde la saison en chaîne de caractères (pour gérer "4-3")
        saison: (saison || "1").replace(/^"|"$/g, "").trim(),
        episodes_vus: parseInt(vus, 10) || 0,
        episodes_dispo: parseInt(dispo, 10) || 0,
        nb_episode: (nb_episode || "").replace(/^"|"$/g, "").trim(),
        id_mal: (id_mal || "").replace(/^"|"$/g, "").trim(),
        slug: (slug || "").replace(/^"|"$/g, "").trim(),
        image_url: (image_url || "").replace(/^"|"$/g, "").trim(),
      };
    });

    // Tri : Animes avec le plus de retard en premier
    animeData.sort(
      (a, b) =>
        (b.episodes_dispo - b.episodes_vus) -
        (a.episodes_dispo - a.episodes_vus)
    );

    displayAnime(animeData);
  } catch (error) {
    console.error("Erreur lors du chargement des anime :", error);
  }
}

function buildAnimeSamaLink(slug, saison) {
  // Fonctionne maintenant parfaitement avec "4-3" car saison est un string
  return `https://anime-sama.to/catalogue/${slug}/saison${saison}/vostfr/`;
}

function displayAnime(data) {
  const animeList = document.getElementById("anime-list");
  animeList.innerHTML = "";

  data.forEach((anime) => {
    const aVoir = anime.episodes_dispo - anime.episodes_vus;
    const lien = buildAnimeSamaLink(anime.slug, anime.saison);

    const card = document.createElement("div");
    card.className =
      "bg-gray-800 rounded-2xl shadow-md p-4 flex flex-col md:flex-row items-start space-x-4 anime-card";

    // On stocke les données brutes dans des attributs data-*
    card.setAttribute("data-titre", anime.titre);
    card.setAttribute("data-slug", anime.slug);
    card.setAttribute("data-saison", anime.saison);
    card.setAttribute("data-episodes-dispo", anime.episodes_dispo);
    card.setAttribute("data-episodes-vus", anime.episodes_vus);

    card.innerHTML = `
      <div class="flex-shrink-0">
        <img
          src="${anime.image_url}"
          alt="${escapeHtml(anime.titre)}"
          onerror="this.src='assets/fallback.jpg'"
          class="w-32 h-48 object-cover mb-4 md:mb-0 rounded-lg"
        >
      </div>

      <div class="flex flex-col justify-start flex-1">
        <h2 class="text-xl font-semibold mb-2">${escapeHtml(anime.titre)}</h2>
        <p class="mb-1">📚 Saison : ${anime.saison}</p>
        <p class="mb-1">🎞️ Total d'épisodes : ${anime.nb_episode || "?"}</p>
        <p class="mb-1 episodes-vus">✔️ Visionnés : ${anime.episodes_vus}</p>
        <p class="mb-1">📅 Sortis : ${anime.episodes_dispo}</p>
        <p class="mb-2 a-voir font-bold ${aVoir > 0 ? 'text-orange-400' : 'text-gray-400'}">
          ${aVoir > 0 ? `🔥 À voir : ${aVoir} épisode${aVoir > 1 ? "s" : ""}` : "✅ À jour"}
        </p>

        <div class="flex flex-wrap gap-2">
            <a
              href="${lien}"
              target="_blank"
              rel="noopener"
              class="watch-link w-48 text-center text-white px-4 py-2 rounded-xl transition ${
                aVoir === 0 ? "bg-gray-600" : "bg-blue-500 hover:bg-blue-600"
              }"
            >
              ${aVoir === 0 ? "Fiche Anime-Sama" : "Ouvrir sur Anime-Sama"}
            </a>

            <button
              class="validate-btn w-48 text-center text-white px-4 py-2 rounded-xl transition ${
                aVoir === 0 ? "cursor-not-allowed bg-gray-600" : "bg-green-500 hover:bg-green-600"
              }"
              ${aVoir === 0 ? "disabled" : ""}
            >
              ${aVoir === 0 ? "Terminé" : "Valider l’épisode vu"}
            </button>
        </div>

        <p class="mt-2 text-sm text-green-500 success-message hidden">Mis à jour !</p>
        <p class="mt-2 text-sm text-red-500 error-message hidden">Erreur de mise à jour.</p>
      </div>
    `;

    const button = card.querySelector(".validate-btn");
    if (!button.disabled) {
      button.addEventListener("click", () => {
        updateEpisodes(anime.titre, anime.episodes_vus, button);
      });
    }

    animeList.appendChild(card);
  });
}

function updateEpisodes(titre, episodes_vus, button) {
  const newEpisodesVus = episodes_vus + 1;

  const url = `${updateUrl}?${new URLSearchParams({
    titre: titre,
    episodes_vus: newEpisodesVus,
    cache_buster: Date.now(),
  })}`;

  // Mode no-cors car Google Script Apps ne renvoie pas les bons headers CORS en GET
  fetch(url, {
    method: "GET",
    mode: "no-cors",
    cache: "no-store",
  })
    .then(() => {
      const container = button.parentElement.parentElement;
      const successMessage = container.querySelector(".success-message");
      
      successMessage.classList.remove("hidden");
      updateAnimeInList(titre, newEpisodesVus);

      setTimeout(() => successMessage.classList.add("hidden"), 3000);
    })
    .catch((err) => {
      const container = button.parentElement.parentElement;
      container.querySelector(".error-message").classList.remove("hidden");
      console.error(err);
    });
}

function updateAnimeInList(titre, newEpisodesVus) {
  const animeCards = document.getElementsByClassName("anime-card");

  for (const card of animeCards) {
    if (card.getAttribute("data-titre") === titre) {
      const episodesVusElement = card.querySelector(".episodes-vus");
      const aVoirElement = card.querySelector(".a-voir");
      const lienElement = card.querySelector(".watch-link");
      const buttonValider = card.querySelector(".validate-btn");

      const episodes_dispo = parseInt(card.getAttribute("data-episodes-dispo"), 10) || 0;
      // MODIFICATION : On récupère la saison telle quelle (string)
      const saison = card.getAttribute("data-saison") || "1";
      const slug = card.getAttribute("data-slug") || "";
      const aVoir = episodes_dispo - newEpisodesVus;
      
      card.setAttribute("data-episodes-vus", newEpisodesVus);

      // Mise à jour visuelle
      episodesVusElement.textContent = `✔️ Visionnés : ${newEpisodesVus}`;
      aVoirElement.textContent = aVoir > 0 ? `🔥 À voir : ${aVoir} épisode${aVoir > 1 ? "s" : ""}` : "✅ À jour";
      aVoirElement.className = `mb-2 a-voir font-bold ${aVoir > 0 ? 'text-orange-400' : 'text-gray-400'}`;

      // Update lien
      lienElement.href = buildAnimeSamaLink(slug, saison);
      
      if (aVoir === 0) {
        lienElement.classList.replace("bg-blue-500", "bg-gray-600");
        lienElement.classList.remove("hover:bg-blue-600");
        buttonValider.disabled = true;
        buttonValider.textContent = "Terminé";
        buttonValider.classList.replace("bg-green-500", "bg-gray-600");
        buttonValider.classList.remove("hover:bg-green-600");
        buttonValider.classList.add("cursor-not-allowed");
      } else {
        // Ré-attachement de l'évenement pour le prochain clic si encore des épisodes
        const newButton = buttonValider.cloneNode(true);
        buttonValider.replaceWith(newButton);
        newButton.addEventListener("click", () => {
          updateEpisodes(titre, newEpisodesVus, newButton);
        });
      }
      break;
    }
  }
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

loadAnime();
