const sheetUrl =
  "https://docs.google.com/spreadsheets/d/1WuGg-AH0X1x5ZdOswZlwn5KxE-V0TKeYTxovN20E9UE/export?format=csv&gid=15026583";

const updateUrl =
  "https://script.google.com/macros/s/AKfycbyGVtKO68L9CZR6s2XDWTvav690n2rHPg03UigmeQjVLyRroT7OhaBkPTYcQ3EZU4slbQ/exec";

async function loadAnime() {
  try {
    const res = await fetch(sheetUrl, { cache: "no-store" });
    const data = await res.text();

    const rows = data.trim().split("\n").slice(1);

    const animeData = rows.map((row) => {
      const [titre, episodes_vus, episodes_dispo, nb_episode, ID_MAL, slug, image_url] =
        row.split(",");

      return {
        titre,
        slug,
        episodes_vus: parseInt(episodes_vus, 10),
        episodes_dispo: parseInt(episodes_dispo, 10),
        nb_episode,
        image_url,
      };
    });

    animeData.sort(
      (a, b) =>
        b.episodes_dispo - b.episodes_vus - (a.episodes_dispo - a.episodes_vus)
    );

    displayAnime(animeData);
  } catch (error) {
    console.error("Erreur lors du chargement des anime :", error);
  }
}

function displayAnime(data) {
  const animeList = document.getElementById("anime-list");
  animeList.innerHTML = "";

  data.forEach((anime) => {
    const aVoir = anime.episodes_dispo - anime.episodes_vus;
    const prochain = anime.episodes_vus + 1;
    const lien = `https://v6.voiranime.com/anime/${anime.slug}/${anime.slug}-${String(prochain).padStart(2, "0")}-vostfr/`;

    const card = document.createElement("div");
    card.className =
      "bg-gray-800 rounded-2xl shadow-md p-4 flex flex-col md:flex-row items-start space-x-4 anime-card";
    card.setAttribute("data-slug", anime.slug);
    card.setAttribute("data-episodes-dispo", anime.episodes_dispo);

    card.innerHTML = `
      <div class="flex-shrink-0">
        <img src="${anime.image_url}" alt="${anime.titre}" onerror="this.src='assets/fallback.jpg'" class="w-32 h-48 object-cover mb-4 md:mb-0">
      </div>
      <div class="flex flex-col justify-start">
        <h2 class="text-xl font-semibold mb-2">${anime.titre}</h2>
        <p class="mb-1">🎞️ Total d'épisodes 🎞️: ${anime.nb_episode}</p>
        <p class="mb-1 episodes-vus">✔️ Visionnés ✔️: ${anime.episodes_vus}</p>
        <p class="mb-1">📅 Sortis 📅: ${anime.episodes_dispo}</p>
        <p class="mb-2 a-voir">🔥 À voir 🔥: ${aVoir} épisode${aVoir > 1 ? "s" : ""}</p>

        <a
          href="${lien}"
          target="_blank"
          rel="noopener"
          class="w-48 text-center text-white px-4 py-2 rounded-xl transition ${
            aVoir === 0
              ? "cursor-not-allowed bg-gray-600"
              : "bg-blue-500 hover:bg-blue-600"
          }"
          ${aVoir === 0 ? 'onclick="return false;"' : ""}
        >
          ${aVoir === 0 ? "À jour" : `Regarder épisode ${prochain}`}
        </a>

        <button
          class="validate-btn w-48 text-center text-white px-4 py-2 rounded-xl transition ${
            aVoir === 0
              ? "cursor-not-allowed bg-gray-600"
              : "bg-green-500 hover:bg-green-600"
          }"
          ${aVoir === 0 ? "disabled" : ""}
          data-title="${anime.titre.replace(/"/g, "&quot;")}"
          data-episodes-vus="${anime.episodes_vus}"
        >
          ${aVoir === 0 ? "À jour" : "Valider l’épisode vu"}
        </button>

        <p class="mt-2 text-sm text-green-500 success-message hidden">Épisodes mis à jour avec succès !</p>
        <p class="mt-2 text-sm text-red-500 error-message hidden">Erreur lors de la mise à jour.</p>
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
    titre,
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
    const animeTitle = card.querySelector("h2").textContent;

    if (animeTitle === titre) {
      const episodesVusElement = card.querySelector(".episodes-vus");
      const aVoirElement = card.querySelector(".a-voir");
      const lienElement = card.querySelector("a");
      const buttonValider = card.querySelector("button");

      const episodes_vus = newEpisodesVus;
      const episodes_dispo = parseInt(card.getAttribute("data-episodes-dispo"), 10);
      const aVoir = episodes_dispo - episodes_vus;

      episodesVusElement.textContent = `✔️ Visionnés ✔️: ${episodes_vus}`;
      aVoirElement.textContent = `🔥 À voir 🔥: ${aVoir} épisode${aVoir > 1 ? "s" : ""}`;

      const prochain = episodes_vus + 1;
      const slug = card.getAttribute("data-slug");
      const lien = `https://v6.voiranime.com/anime/${slug}/${slug}-${String(prochain).padStart(2, "0")}-vostfr/`;

      lienElement.href = lien;
      lienElement.textContent = aVoir === 0 ? "À jour" : `Regarder épisode ${prochain}`;
      lienElement.classList.toggle("cursor-not-allowed", aVoir === 0);
      lienElement.classList.toggle("bg-gray-600", aVoir === 0);
      lienElement.classList.toggle("bg-blue-500", aVoir !== 0);
      lienElement.classList.toggle("hover:bg-blue-600", aVoir !== 0);

      if (aVoir === 0) {
        buttonValider.disabled = true;
        buttonValider.textContent = "À jour";
        buttonValider.classList.remove("bg-green-500", "hover:bg-green-600");
        buttonValider.classList.add("bg-gray-600", "cursor-not-allowed");
      } else {
        buttonValider.onclick = () => updateEpisodes(titre, episodes_vus, buttonValider);
      }

      break;
    }
  }
}

loadAnime();
