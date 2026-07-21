# Photo QGIS Tool

Outil web (100 % client, aucune donnée envoyée à un serveur) en deux parties :

- **Compression rapide** : glissez des photos (JPEG, PNG, HEIC/HEIF), compressez et téléchargez.
- **Export QGIS** : sélectionnez, renommez, compressez et géolocalisez un lot de photos, puis exportez un ZIP contenant un projet QGIS prêt à l'emploi (GeoJSON, CSV, Shapefile ESRI réel `.shp/.shx/.dbf/.prj`, et les photos).

## Utiliser l'outil

- En ligne (une fois GitHub Pages activé, voir ci-dessous) : `https://ratapouik.github.io/photo-qgis-tool/`
- En local : double-cliquez sur `index.html` (connexion internet nécessaire pour charger Leaflet, JSZip, exifr et heic2any depuis un CDN).

## Activer GitHub Pages (une seule fois)

`Settings ▸ Pages ▸ Build and deployment` → Source : **Deploy from a branch**, branche `main`, dossier `/ (root)`. Après ~1 min, le site est en ligne à l'URL ci-dessus.
