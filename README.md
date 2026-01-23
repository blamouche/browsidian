# Obsidian Web

Web app locale (sans dépendances) pour parcourir et modifier un dossier Obsidian directement dans le navigateur.

## Prérequis

- Node.js 18+ (recommandé)

## Lancer

Option A — mode serveur (le serveur lit/écrit sur disque) : choisis le chemin du vault Obsidian (le dossier qui contient tes notes) :

```bash
export OBSIDIAN_VAULT="/chemin/vers/ton/vault"
npm start
```

Ou :

```bash
node server.js --vault "/chemin/vers/ton/vault" --port 5173
```

Puis ouvre `http://127.0.0.1:5173`.

## Notes

- Les endpoints `GET /api/list`, `GET /api/read`, `PUT /api/write` sont limités au vault (protection contre `..`).
- Les dossiers `.obsidian`, `.git`, `node_modules` sont ignorés dans l’explorateur.
- Option B — mode navigateur: lance le serveur sans vault puis clique sur **Choisir un vault local** (Chrome/Edge/Brave) pour travailler directement sur un dossier choisi via le navigateur.
- L’éditeur fait une auto-sauvegarde après ~1s d’inactivité (et tu peux toujours faire Ctrl+S).
- Drag & drop: tu peux déplacer un fichier en le glissant sur un dossier dans la barre de gauche (déplacement/rename).
- En aperçu, les liens Obsidian `[[...]]` sont cliquables et ouvrent la note correspondante.
