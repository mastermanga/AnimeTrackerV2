const sheetUrl =
  "https://docs.google.com/spreadsheets/d/1WuGg-AH0X1x5ZdOswZlwn5KxE-V0TKeYTxovN20E9UE/export?format=csv&gid=15026583";

const updateUrl =
  "https://script.google.com/macros/s/AKfycby-V1gcNKBdN7Lt2HqdrwdyzNfdVJO8m_mAeXoGRIWSO0AHBFE0c2ac-bP9krEa_A/exec";

async function loadAnime() {
  try {
    const res = await fetch(sheetUrl, { cache: "no-store" });
    const data = await res.text();

    const rows = data.trim().split("\n").slice(1);

    const animeData = rows.map((row) => {
      const [titre, saison, vus, dispo, nb_episode, id_mal, slug, image_url] =
        row.split(",");

      return {
        titre: (titre || "").trim(),
        saison: parseInt(saison, 10) || 1,
        episodes_vus: parseInt(vus, 10) || 0,
        episodes_dispo: parseInt(dispo, 10) || 0,
        nb_episode: (nb_episode || "").trim(),
        id_mal: (id_mal || "").trim(),
        slug: (slug || "").trim(),
        image_url: (image_url || "").trim(),
      };
    });

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
          class="w-32 h-48 object-cover mb-4 md:mb-0"
        >
      </div>

      <div class="flex flex-col justify-start">
        <h2 class="text-xl font-semibold mb-2">${escapeHtml(anime.titre)}</h2>
        <p class="mb-1">📚 Saison 📚: ${anime.saison}</p>
        <p class="mb-1">🎞️ Total d'épisodes 🎞️: ${anime.nb_episode || "?"}</p>
        <p class="mb-1 episodes-vus">✔️ Visionnés ✔️: ${anime.episodes_vus}</p>
        <p class="mb-1">📅 Sortis 📅: ${anime.episodes_dispo}</p>
        <p class="mb-2 a-voir">🔥 À voir 🔥: ${aVoir} épisode${Math.abs(aVoir) > 1 ? "s" : ""}</p>

        <a
          href="${lien}"
          target="_blank"
          rel="noopener"
          class="watch-link w-48 text-center text-white px-4 py-2 rounded-xl transition ${
            aVoir === 0
              ? "bg-gray-600"
              : "bg-blue-500 hover:bg-blue-600"
          }"
        >
          ${aVoir === 0 ? "À jour sur Anime-Sama" : "Ouvrir sur Anime-Sama"}
        </a>

        <button
          class="validate-btn w-48 text-center text-white px-4 py-2 rounded-xl transition ${
            aVoir === 0
              ? "cursor-not-allowed bg-gray-600"
              : "bg-green-500 hover:bg-green-600"
          }"
          ${aVoir === 0 ? "disabled" : ""}
        >
          ${aVoir === 0 ? "À jour" : "Valider l’épisode vu"}
        </button>

        <p class="mt-2 text-sm text-green-500 success-message hidden">
          Épisodes mis à jour avec succès !
        </p>
        <p class="mt-2 text-sm text-red-500 error-message hidden">
          Erreur lors de la mise à jour.
        </p>
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

  fetch(url, {
    method: "GET",
    mode: "no-cors",
    cache: "no-store",
  })
    .then(() => {
      const successMessage = button.parentElement.querySelector(".success-message");
      const errorMessage = button.parentElement.querySelector(".error-message");

      successMessage.classList.remove("hidden");
      errorMessage.classList.add("hidden");

      updateAnimeInList(titre, newEpisodesVus);

      setTimeout(() => successMessage.classList.add("hidden"), 3000);
    })
    .catch((err) => {
      const successMessage = button.parentElement.querySelector(".success-message");
      const errorMessage = button.parentElement.querySelector(".error-message");

      successMessage.classList.add("hidden");
      errorMessage.classList.remove("hidden");

      console.error(err);
    });
}

function updateAnimeInList(titre, newEpisodesVus) {
  const animeList = document.getElementById("anime-list");
  const animeCards = animeList.getElementsByClassName("anime-card");

  for (const card of animeCards) {
    const animeTitle = card.getAttribute("data-titre");

    if (animeTitle === titre) {
      const episodesVusElement = card.querySelector(".episodes-vus");
      const aVoirElement = card.querySelector(".a-voir");
      const lienElement = card.querySelector(".watch-link");
      const buttonValider = card.querySelector(".validate-btn");

      const episodes_dispo =
        parseInt(card.getAttribute("data-episodes-dispo"), 10) || 0;
      const saison = parseInt(card.getAttribute("data-saison"), 10) || 1;
      const slug = card.getAttribute("data-slug") || "";
      const aVoir = episodes_dispo - newEpisodesVus;
      const lien = buildAnimeSamaLink(slug, saison);

      card.setAttribute("data-episodes-vus", newEpisodesVus);

      episodesVusElement.textContent = `✔️ Visionnés ✔️: ${newEpisodesVus}`;
      aVoirElement.textContent = `🔥 À voir 🔥: ${aVoir} épisode${Math.abs(aVoir) > 1 ? "s" : ""}`;

      lienElement.href = lien;
      lienElement.textContent =
        aVoir === 0 ? "À jour sur Anime-Sama" : "Ouvrir sur Anime-Sama";
      lienElement.classList.remove(
        "bg-blue-500",
        "hover:bg-blue-600",
        "bg-gray-600"
      );
      lienElement.classList.add(aVoir === 0 ? "bg-gray-600" : "bg-blue-500");
      if (aVoir !== 0) {
        lienElement.classList.add("hover:bg-blue-600");
      }

      if (aVoir === 0) {
        buttonValider.disabled = true;
        buttonValider.textContent = "À jour";
        buttonValider.classList.remove("bg-green-500", "hover:bg-green-600");
        buttonValider.classList.add("bg-gray-600", "cursor-not-allowed");
      } else {
        buttonValider.disabled = false;
        buttonValider.textContent = "Valider l’épisode vu";
        buttonValider.classList.remove("bg-gray-600", "cursor-not-allowed");
        buttonValider.classList.add("bg-green-500", "hover:bg-green-600");
      }

      const newButton = buttonValider.cloneNode(true);
      buttonValider.replaceWith(newButton);

      if (!newButton.disabled) {
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
