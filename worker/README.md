# Proxy temps réel (phase 7, mode en ligne)

Petit Worker Cloudflare qui garde les tokens CTS et SNCF côté serveur — un
site statique ne peut pas les embarquer sans les exposer à tous. Lecture
seule : aucun endpoint d'écriture n'est relayé.

## Obtenir les tokens

- **CTS** : compte sur https://www.cts-strasbourg.eu/fr/open-data/, puis
  générer un token pour l'API temps réel (SIRI Lite). Documentation
  interactive : https://api.cts-strasbourg.eu/index.html (spec brute :
  `https://api.cts-strasbourg.eu/v1/swagger.json`).
- **SNCF** : compte sur https://www.digital.sncf.com/startup/api, clé pour
  l'API Navitia (`https://api.sncf.com`). Documentation : https://doc.navitia.io/.

Les deux API s'authentifient en **HTTP Basic**, avec le token comme nom
d'utilisateur et un mot de passe vide — c'est déjà géré par `index.js`.

## Déployer

```
npm install -g wrangler       # une fois, nécessite Node (absent de ce poste
                                de dev — à faire depuis une machine qui l'a,
                                ou via le Worker Playground cloudflare.com)
cd worker
wrangler login
wrangler secret put CTS_TOKEN
wrangler secret put SNCF_TOKEN
wrangler deploy
```

`wrangler deploy` affiche l'URL du Worker (`https://strasbourg-eurometropole-
temps-reel.<compte>.workers.dev`). Une fois l'app publiée sur GitHub Pages
(phase 8), éditer `wrangler.toml` pour fixer `ALLOWED_ORIGIN` à cette URL
plutôt que `*`, et redéployer.

Coller ensuite l'URL du Worker dans le panneau « Mode en ligne » de l'app
(bouton dans la fiche « Carte hors ligne ») — voir `temps-reel.js` à la
racine du projet. Tant qu'aucune URL n'est configurée, l'app se comporte
exactement comme en phase 6 : uniquement les horaires théoriques.

## Non vérifié en conditions réelles

Écrit à partir de la spécification OpenAPI publique de CTS
(`api.cts-strasbourg.eu/v1/swagger.json`) et de la documentation Navitia,
mais **sans token pour tester de vraies réponses**. À la première vraie
requête, vérifier en particulier :

- le format exact de `MonitoringRef` accepté (le champ `refs` envoyé par
  l'app vient du `stop_code` GTFS CTS, ex. `10A` — c'est la valeur
  recommandée par le swagger, mais à confirmer) ;
- la conversion de l'identifiant de gare SNCF (`StopArea:OCE...` du GTFS
  vers `stop_area:OCE...` pour Navitia) ;
- la présence effective des champs `base_departure_date_time` /
  `departure_date_time` dans les réponses `departures` (utilisés pour
  détecter un retard).

Si un champ diffère, la correction se fait uniquement dans `index.js` —
rien côté client à changer, `temps-reel.js` ne connaît que le contrat
normalisé `{ligne, destination, heure}` / `{ligne, destination, theorique,
estime, retard}`.
