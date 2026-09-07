# Photo QGIS Tool

Photos de chantier géolocalisées → livrable QGIS. Tout se fait dans le navigateur :
aucune image, aucune coordonnée ne part vers un serveur.

Deux applications, un même livrable :

- **`index.html`** — l'outil de bureau. Un parcours en cinq étapes : sélection des
  photos, renommage (à l'unité ou en série), compression, placement sur une carte
  (les photos sans GPS se posent au clic), puis export.
- **`terrain/`** — l'application de terrain, installable sur Android et utilisable
  hors-ligne. On photographie, l'appli relève la position, et l'export se fait
  depuis le téléphone. Voir [`terrain/INSTALLATION.md`](terrain/INSTALLATION.md).

## Ce que contient l'export

L'outil de bureau produit un ZIP avec, au choix :

- **Projet QGIS** — `projet_photos.qgs` prêt à ouvrir (couche des points + orthophoto
  IGN), `photos.geojson`, `photos.csv`, et un vrai Shapefile ESRI
  (`.shp` / `.shx` / `.dbf` / `.prj` / `.cpg`, points 3D avec altitude) ;
- **Photos** — les JPEG recompressés ;
- **Compte-rendu PDF** — un plan de localisation A4 paysage sur orthophoto IGN, avec
  repères numérotés, flèche du nord, échelle graphique et cartouche de situation,
  puis une fiche par photo renvoyant à son numéro sur le plan.

L'application de terrain produit le même compte-rendu, avec `points.geojson`,
`points.csv` et les photos.

La mise en page du compte-rendu vit dans **`compte-rendu.js`**, partagé par les deux
applications : le client reçoit le même document, qu'il ait été produit au bureau ou
sur le chantier.

## Utiliser l'outil

- En ligne : `https://ratapouik.github.io/photo-qgis-tool/`
  (terrain : `https://ratapouik.github.io/photo-qgis-tool/terrain/`)
- En local : ouvrez `index.html` dans un navigateur. Une connexion internet reste
  nécessaire pour charger Leaflet, JSZip, exifr, heic2any et jsPDF depuis un CDN, et
  pour les fonds de carte IGN. Sans réseau, le plan du compte-rendu se replie sur un
  schéma sans fond de carte plutôt que d'échouer.

## Vérifier la couverture de l'orthophoto IGN

`verif-couverture.html` interroge le WMTS de la Géoplateforme sur une grille de points
et indique, niveau de zoom par niveau de zoom, où l'orthophoto existe réellement et si
le Plan IGN prend le relais là où elle manque. C'est ce qui permet de revérifier le
zoom maximal servi si l'IGN fait évoluer son service :
`https://ratapouik.github.io/photo-qgis-tool/verif-couverture.html`

## Activer GitHub Pages (une seule fois)

`Settings ▸ Pages ▸ Build and deployment` → Source : **Deploy from a branch**, branche
`main`, dossier `/ (root)`. Après ~1 min, le site est en ligne à l'URL ci-dessus.
