"use strict";
/* Enregistrement du service worker + téléchargement à la demande du fond de
 * carte (data/tiles.pmtiles, ~30 Mo) dans son propre cache. Le reste de
 * l'app (code, styles, glyphes, données réseau/musées) est pré-caché par
 * sw.js dès l'installation : rien d'autre à faire ici. */
var Pwa = (function () {
  var URL_TUILES = "data/tiles.pmtiles";
  var TILES_CACHE = "strasbourg-tuiles-v1";
  var CLE_MARQUEUR = "data/tiles-version.json";

  function support() {
    return "serviceWorker" in navigator && "caches" in window;
  }

  function enregistrerServiceWorker() {
    if (!support()) return;
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }

  function avertirServiceWorker() {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: "tuiles-modifiees" });
    }
  }

  function tailleLisible(octets) {
    if (octets > 1000 * 1000) return (octets / (1000 * 1000)).toFixed(1) + " Mo";
    return Math.round(octets / 1000) + " Ko";
  }

  function carteInstallee() {
    return caches.open(TILES_CACHE).then(function (c) {
      return c.match(URL_TUILES).then(function (r) { return !!r; });
    });
  }

  function marqueurLocal() {
    return caches.open(TILES_CACHE).then(function (c) {
      return c.match(CLE_MARQUEUR).then(function (r) { return r ? r.json() : null; });
    });
  }

  function versionDistante() {
    return fetch("data/version.json", { cache: "no-cache" })
      .then(function (r) { return r.json(); })
      .then(function (v) { return v.tuiles || null; })
      .catch(function () { return null; });
  }

  function installerCarte(onProgress) {
    return fetch(URL_TUILES).then(function (reponse) {
      if (!reponse.ok || !reponse.body) throw new Error("réponse réseau invalide");
      var total = parseInt(reponse.headers.get("Content-Length") || "0", 10);
      var lecteur = reponse.body.getReader();
      var morceaux = [];
      var recu = 0;

      function lire() {
        return lecteur.read().then(function (etat) {
          if (etat.done) return;
          morceaux.push(etat.value);
          recu += etat.value.length;
          if (onProgress) onProgress(recu, total);
          return lire();
        });
      }

      return lire().then(function () {
        var bloc = new Blob(morceaux);
        var corps = new Response(bloc, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(bloc.size),
            "Accept-Ranges": "bytes",
          },
        });
        return caches.open(TILES_CACHE).then(function (c) {
          return Promise.all([
            c.put(URL_TUILES, corps),
            versionDistante().then(function (v) {
              if (v) return c.put(CLE_MARQUEUR, new Response(JSON.stringify(v)));
            }),
          ]);
        });
      }).then(function () {
        avertirServiceWorker();
      });
    });
  }

  function supprimerCarte() {
    return caches.open(TILES_CACHE).then(function (c) {
      return Promise.all([c.delete(URL_TUILES), c.delete(CLE_MARQUEUR)]);
    }).then(avertirServiceWorker);
  }

  function ouvrirPanneau() {
    var corps = Transports.ouvrirFiche("Carte hors ligne", "");
    corps.textContent = "";

    var etat = document.createElement("p");
    etat.className = "note";
    etat.textContent = "Vérification…";
    corps.appendChild(etat);

    var barre = document.createElement("div");
    barre.className = "progression";
    barre.hidden = true;
    var remplissage = document.createElement("div");
    barre.appendChild(remplissage);
    corps.appendChild(barre);

    var actions = document.createElement("div");
    actions.className = "actions";
    corps.appendChild(actions);

    function bouton(texte, onClick) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = texte;
      b.addEventListener("click", onClick);
      actions.appendChild(b);
      return b;
    }

    function rafraichir() {
      actions.textContent = "";
      barre.hidden = true;
      Promise.all([carteInstallee(), marqueurLocal(), versionDistante()]).then(function (r) {
        var installee = r[0], local = r[1], distant = r[2];
        if (!support()) {
          etat.textContent = "Navigateur non compatible avec le mode hors ligne.";
          return;
        }
        if (!installee) {
          etat.textContent = "Le fond de carte (~30 Mo) n'est pas encore installé : " +
            "sans lui, la carte a besoin du réseau pour s'afficher.";
          bouton("Installer la carte hors ligne", function () { lancerInstallation(); });
          return;
        }
        var perime = local && distant && local.donnees_osm !== distant.donnees_osm;
        etat.textContent = perime
          ? "Carte installée, mais une version plus récente existe (" + distant.donnees_osm + ")."
          : "Carte installée : disponible hors ligne.";
        if (perime) bouton("Mettre à jour la carte", function () { lancerInstallation(); });
        bouton("Supprimer la carte hors ligne", function () {
          supprimerCarte().then(rafraichir);
        });
      });
    }

    function lancerInstallation() {
      actions.textContent = "";
      barre.hidden = false;
      remplissage.style.width = "0%";
      etat.textContent = "Téléchargement…";
      installerCarte(function (recu, total) {
        if (total) {
          remplissage.style.width = Math.round((recu / total) * 100) + "%";
          etat.textContent = "Téléchargement… " + tailleLisible(recu) + " / " + tailleLisible(total);
        } else {
          etat.textContent = "Téléchargement… " + tailleLisible(recu);
        }
      }).then(rafraichir).catch(function (e) {
        etat.textContent = "Échec du téléchargement : " + e.message;
        barre.hidden = true;
        bouton("Réessayer", function () { lancerInstallation(); });
      });
    }

    rafraichir();
  }

  function initialiser() {
    enregistrerServiceWorker();
    var chip = document.getElementById("chip-horsligne");
    if (chip) chip.addEventListener("click", ouvrirPanneau);
  }

  return { initialiser: initialiser, ouvrirPanneau: ouvrirPanneau };
})();

Pwa.initialiser();
