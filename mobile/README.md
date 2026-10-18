# Lokal pour Android

Lokal tourne **entièrement sur le téléphone** : le serveur de Lokal (le même que sur PC) démarre dans un Node.js embarqué dans l'appli, et l'interface de Lokal s'affiche par-dessus. Pas besoin de PC, pas de connexion requise pour écouter ta musique.

## Installer

1. Ouvre la page **Releases** du dépôt → **Lokal Android** (`android-latest`).
2. Télécharge l'APK **arm64-v8a** (presque tous les téléphones récents ; `armeabi-v7a` pour les vieux téléphones 32 bits, `x86_64` pour les émulateurs).
3. Ouvre-le sur le téléphone et autorise l'installation depuis cette source si Android le demande.
4. Au premier lancement, autorise **Musique et audio**, puis choisis ton dossier de musique (par défaut `Musique`).

Chaque nouvelle build met à jour la précédente (même signature).

## Ce qui marche

- Bibliothèque : scan du dossier choisi (plusieurs dossiers possibles), tags MP3/FLAC/M4A/OGG/Opus/WAV, pochettes intégrées, artistes « feat. » séparés, albums, genres, recherche.
- Lecture : file d'attente, aléatoire/répétition, égaliseur et effets du lecteur, paroles `.lrc` et paroles en ligne.
- **En arrière-plan** : notification de lecture, contrôles sur l'écran verrouillé, casque et Bluetooth.
- Playlists (normales et intelligentes), titres likés, historique, Recap, mixes « Made for you ».
- Rescan automatique au démarrage (les fichiers ajoutés pendant que l'appli était fermée apparaissent).
- Interface adaptée au téléphone : barre du bas (Accueil, Recherche, Bibliothèque, Menu), mini-lecteur, lecteur plein écran vertical, bouton retour.
- Last.fm / ListenBrainz (scrobbling) et les fonctions en ligne en pur JavaScript, quand le téléphone a Internet.
- **SpotiFLAC dans Lokal** : les extensions SpotiFLAC (Deezer, Qobuz, Tidal, Amazon…) s'installent dans Réglages → Addons et téléchargent directement dans la bibliothèque. Les vérifications (captcha, connexion) s'ouvrent dans une fenêtre de l'appli. `ffprobe` est remplacé par la lecture des tags, et `ffmpeg` (déchiffrement Amazon, changements de conteneur) tourne en WebAssembly.
- **Synchro avec l'appli SpotiFLAC** : Bibliothèque (ou Réglages → Addons) → *Synchro avec l'appli SpotiFLAC* → choisis le dossier où SpotiFLAC télécharge. Les nouveaux titres arrivent tout seuls : à chaque retour dans Lokal, toutes les 30 s quand Lokal est ouvert, et au démarrage. Le bouton *Ouvrir SpotiFLAC* bascule vers l'appli.
- Apple Lossless (ALAC) : lu via une copie FLAC faite par ffmpeg WebAssembly.

## Limites connues

- **Téléchargements YouTube / SoundCloud via yt-dlp** : `yt-dlp` est un programme Python qu'Android ne laisse pas lancer. Ces boutons renvoient une erreur (les extensions SpotiFLAC, elles, marchent).
- **ffmpeg en WebAssembly** est plus lent que sur PC (quelques secondes pour convertir un titre) et charge le fichier entier en mémoire.
- **Synchro SpotiFLAC** : dans SpotiFLAC, le dossier de téléchargement doit être un dossier du téléphone (ex. `Musique/SpotiFLAC`, choisi avec le sélecteur), pas le « dossier de l'appli » : Android interdit aux autres applis de le lire.
- **Modifier les tags / supprimer des fichiers** : demande l'accès « Tous les fichiers » (Réglages Android → Applis → Lokal → Autorisations).
- Le Cast, Discord, le mode « mini-lecteur » et les mises à jour automatiques du PC n'existent pas sur téléphone.
- Le moteur Node.js embarqué (nodejs-mobile) est en version 18 et n'est plus maintenu : il fonctionne, mais c'est le point fragile du portage.

## Comment c'est fait

```
mobile/
  backend/      le serveur Lokal adapté au Node.js du téléphone
    entry.js         démarre server/index.js (données dans le stockage privé de l'appli, écoute sur 127.0.0.1 uniquement)
    sqlite-adapter.js  remplace better-sqlite3 (module natif) par SQLite en WebAssembly, même API
    polyfills.js     Intl, normalize, localeCompare, TextDecoder : Node 18 sans ICU
    tools.js         ffmpeg (WebAssembly, dans un worker) et ffprobe (tags) à la place des programmes
  shell/        la page de l'appli : démarrage, autorisations, cadre de l'interface, notification média
  android/      le projet Android (Capacitor) + LokalNativePlugin (sélecteur de dossier, autorisations)
  scripts/      build-backend (esbuild + regex Unicode réécrites), build-shell, tests
```

Côté interface (`src/`), `android.js` relie l'interface à l'appli (notification média, sélecteur de dossier, bouton retour) et `PhoneBar.jsx` / `phoneLayout.js` donnent la disposition téléphone ; sur PC rien ne change.

## Compiler

Automatique : chaque push sur `main` lance **Actions → Android APK**, qui teste le serveur sous Node 18 sans ICU, compile les APK et les publie sur la release `android-latest`.

En local (Node 24, JDK 21, SDK Android) :

```bash
npm ci --ignore-scripts          # à la racine
cd mobile && npm ci
npm run build                     # interface + serveur + shell
npx cap sync android
cd android && ./gradlew assembleRelease
```

Tester le serveur sans téléphone : `bash scripts/make-test-music.sh /tmp/musique && node scripts/smoke-test.mjs /tmp/musique <chemin vers node 18>`.

### Ta propre clé de signature (optionnel)

Par défaut les APK sont signés avec `android/lokal-shared.keystore` (publique, pratique pour un usage perso). Pour ta propre clé : crée un keystore, puis ajoute dans **Settings → Secrets → Actions** : `LOKAL_KEYSTORE_BASE64` (le fichier en base64), `LOKAL_KEYSTORE_PASSWORD`, `LOKAL_KEY_ALIAS`, `LOKAL_KEY_PASSWORD`. Attention : changer de clé oblige à désinstaller l'ancienne appli une fois.

### Licences

ffmpeg WebAssembly (`@ffmpeg/core`) est sous GPL ; si tu redistribues l'APK, la GPL s'applique à cette partie.
