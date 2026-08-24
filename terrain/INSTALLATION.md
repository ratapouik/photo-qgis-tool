# Relevé — installation sur Android

L'application est un site statique : rien à compiler, aucune dépendance à installer.
Tout le traitement (photo, GPS, compression, ZIP, PDF) se fait dans le navigateur du
téléphone ; aucune image ne part vers un serveur.

## 1. Mettre les fichiers en ligne

Copier le contenu de ce dossier dans ton dépôt `photo-qgis-tool`, dans un sous-dossier
`terrain/` :

    terrain/index.html
    terrain/support.js
    terrain/ds/styles.css
    terrain/ds/_ds_bundle.js
    terrain/manifest.webmanifest
    terrain/sw.js
    terrain/icon-192.png
    terrain/icon-512.png

GitHub Pages est déjà décrit dans ton README : `Settings > Pages`, source `main`,
dossier `/ (root)`. L'appli sera servie sur
`https://ratapouik.github.io/photo-qgis-tool/terrain/`.

L'adresse doit être en HTTPS : c'est la condition pour que l'appareil photo, le GPS et
le mode hors-ligne fonctionnent, et pour que l'installation soit proposée.

## 2. Installer sur le téléphone

1. Ouvrir l'adresse dans Chrome sur Android.
2. Menu ⋮ > Installer l'application (ou « Ajouter à l'écran d'accueil »).
3. Lancer depuis l'icône : l'appli s'ouvre en plein écran, sans barre de navigateur.

Au premier lancement, garder du réseau quelques secondes : les librairies d'export
(JSZip, exifr, jsPDF) et les polices sont téléchargées puis mises en cache. Ensuite
l'appli fonctionne hors-ligne. Faire un export test avec une photo avant de partir sur
le terrain : c'est ce qui remplit le cache.

## 3. Autorisations

Chrome demandera, à la première utilisation :

- Appareil photo — bouton « Prendre une photo » (c'est l'appli photo du système qui
  s'ouvre, avec son autofocus).
- Position — boutons « Relever ma position » et « Utiliser ma position ». Choisir
  « Autoriser pendant l'utilisation ».

Autorisation refusée par erreur : icône cadenas dans la barre d'adresse >
Autorisations > réactiver.

## 4. Ce que produit l'export

Un ZIP nommé « Client - Ville.zip » contenant :

- `photos/` — les JPEG recompressés (préréglage léger / moyen / fort),
- `points.geojson` — un point par photo, en WGS 84 (EPSG:4326), champs `nom`,
  `photo`, `date`, `precision_m`, `source_position`, `poids_ko`,
- `points.csv` — même contenu, séparateur point-virgule,
- `Client - Ville.pdf` — le compte-rendu : une page par photo, coordonnées et date,
- `lisez-moi.txt` — le rappel de la manipulation QGIS.

Le bouton Partager passe par le partage Android (mail, Drive, WhatsApp) ; Enregistrer
dépose le ZIP dans les téléchargements du téléphone.

## 5. Côté QGIS

1. Décompresser le ZIP dans un dossier de travail.
2. Glisser `points.geojson` dans la carte.
3. Propriétés de la couche > Formulaire d'attributs : champ `photo` en widget
   « Pièce jointe », mode de chemin « relatif au projet ».
4. Enregistrer le projet `.qgs` dans ce même dossier — les vignettes s'affichent alors
   dans le formulaire.

## Limites connues

- Une PWA ne peut pas photographier écran éteint ni en arrière-plan.
- Les coordonnées ne sont pas réécrites dans l'EXIF des JPEG compressés : elles vivent
  dans le GeoJSON, le CSV et le PDF. Si tu as besoin de JPEG géotagués, il faut insérer
  le segment EXIF à la main — dis-le et je l'ajoute.
- Au-delà d'environ 150 photos par export, générer en deux lots : le ZIP et le PDF sont
  construits en mémoire.
