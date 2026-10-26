# jj orbit

3D-Viewer für jj-Repos. Nur Python-Standardbibliothek, getestet mit jj 0.46 (braucht `json()` in Templates).

## Live-Server

    python3 jj_orbit_server.py -R ~/repo --open

- Exportiert nach jeder jj-Operation neu (überwacht `.jj/repo/op_heads/heads`) und schiebt den Stand per SSE in den Browser.
- Automatische Exporte snapshotten die Working Copy nicht (`--ignore-working-copy`), sonst würde jeder Export eine neue Operation auslösen. „Neu einlesen“ (Taste R) snapshottet.
- Op-Logs vergangener Operationen und Evologs werden im Prozess gecacht; Folge-Exporte brauchen nur die neuen Ops.
- Lauscht nur auf 127.0.0.1. Optionen: `--port`, `--ops N` (Standard 100, 0 = ohne Op-Slider), `-r REVSET`, `--window N`, `--evolog-depth N` (Standard 30, 0 = alle), `--evolog-budget S`, `-j N`, `--profile`, `--no-watch`, `--interval`, `--debounce`.
- Evologs: Standard `--evolog lazy`, d. h. der Export enthält keine; der Viewer holt die früheren Versionen eines Commits erst, wenn du ihn auswählst (ein `jj evolog`-Aufruf, gecacht). `--evolog eager` lädt alle vorab, `--evolog off` gar keine.
- Mit `--evolog eager`: Evologs kommen gebündelt aus einem `jj evolog`-Aufruf pro 200 Commits (jj durchläuft dafür jedes Mal das Op-Log). Scheitert ein Bündel an einem fehlenden Objekt, wird es halbiert, bis nur die betroffenen Commits einzeln und tiefenbegrenzt gelesen werden. Die Op-Historie wird parallel gelesen (`-j`). Danach liest der Server nur noch neue Ops und neue Commits.

## Ohne Server

    python3 jj_export.py -R ~/repo --ops 100   # -> jj-orbit.json

`jj-orbit.html` öffnen und die JSON-Datei hineinziehen.

## Aktionen (Live-Modus)

Umschreiben: rebase (-r/-s/-b, -o/-A/-B, Merge), squash (ganz oder dateiweise), split (dateiweise), abandon,
describe, metaedit, simplify-parents, absorb. Neu: new (auch Merge), duplicate, revert, parallelize, commit.
Sonst: edit, Bookmarks (set, rename, delete, forget, advance, track/untrack, push), Tags (set, delete,
track/untrack), workspace add/forget, converge, restore (Datei verwerfen oder aus früherer Version übernehmen),
git fetch, op restore aus dem Op-Slider. Lesend: Dateiinhalt, Diff/Interdiff zweier Commits im Vergleich, op show.

Vorschau: strukturelle Aktionen werden sofort simuliert; „Konflikte prüfen“ lässt jj den Befehl mit
`--no-integrate-operation` ausführen und zeigt den echten Stand, ohne ihn zu übernehmen. Push zeigt stattdessen
einen `--dry-run`. „Rückgängig“ nimmt genau die ausgeführte Operation mit `jj op revert` zurück.
Der Server nimmt nur diese Befehle mit vollständigen Commit-IDs an, öffnet nie einen Editor und fragt nie nach
Anmeldedaten (SSH BatchMode, GIT_TERMINAL_PROMPT=0). `--read-only` schaltet Aktionen ab.

## Neu in 0.12

- Oberfläche auf Englisch.
- Revset-Leiste (Live-Modus): Treffer hervorheben, Chip „Revset“ filtert Äste.
- Zeilenweise split / squash / restore über jjs Diff-Editor-Protokoll; der Server bringt dafür ein eigenes Hilfsskript mit (`--tool orbit-lines`).
- Rebase onto trunk, Abandon mit Nachfahren, Konfliktdateien pro Commit (mit „open in editor“ für die Working Copy).
- Doppelklick: Edit (veränderbar) bzw. New (unveränderlich), jeweils mit Bestätigung.

## Moves (0.13)

`reviewdiff-core.js` ist der Kern von ReviewDiff (MIT, © 2026 Zurich Instruments AG, enthält VS-Code-Code unter MIT), für den Browser gebündelt
(SHA-256 per Shim statt `node:crypto`). Der Server liefert ihn aus; die Erkennung läuft im Viewer in einem Web Worker.
Für den gewählten Commit (ein Elternteil) bzw. im Vergleich zweier Commits: verschobene Blöcke, auch zwischen Dateien,
und reine Formatierungs-Hunks. Taste M schaltet das ab.

## Offline (0.16)

`vendor/` enthält three.js 0.147.0 (MIT) und highlight.js 11.9.0 (BSD-3), jeweils mit Lizenz. Liegt der Ordner neben dem
Server, liefert er die Seite mit lokalen Pfaden aus; der Viewer braucht dann kein Netz (nur die Webfonts fallen auf
System-Schriften zurück).
