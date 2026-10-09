# Fortsetzung: Maestro Custom

Stand: 2026-10-09. Branch `codex/custom-orchestration`, Ausgangspunkt `fea4472e` (Maestro 0.35.1, Protokoll 13). Der Auftrag ist **nicht vollständig erfüllt**. Die implementierte Grundlage ist beschrieben in `custom-orchestration.md`. Keine Produktionstauglichkeit und keine vollständige Abnahme A–G behaupten.

## Gesicherter Umfang

- Custom-App-ID, Daten-/Secret-/Daemon-/Autostart-Namensräume; gebündelte selbst gebaute Daemons; offizielle Updates/Daemon-Downloads deaktiviert.
- Projektübernahme mit sichtbarem Bestätigungsdialog; `.maestro` bleibt projektgebunden.
- Protokoll 14, gemeinsame Rust-Modelle und generierte TypeScript-Bindings.
- Daemon-Migrationen v10/v11: Team, Features, Zuordnungen, Nachrichten und verifizierte Integrationsnachweise.
- Team mit bestehenden Profilen; Feature-Formular und Detaildialog im Kanban; vorhandene Task-/Session-/Review-Ansichten erreichbar.
- Orchestrator als bestehender Planner-Task mit vier neuen MCP-Tools; strukturierte Planübernahme atomar/idempotent; Abhängigkeiten azyklisch und projektbezogen.
- Queue-/Claim-/SessionReady-Guards; menschliche Plan- und Merge-Freigabe; Feature-Branch als erzwungenes Integrationsziel; gespeicherter Integrations-Commit als Voraussetzung.
- Prüfung, dass die konkrete Worker-Arbeitsbasis die erforderlichen Integrations-Commits enthält. Alte Worktrees werden bei fehlendem Commit mit einer Fehlermeldung gesperrt, nicht gelöscht.
- Persistente Nachrichten mit Deduplizierung, Übergabe an freie bestehende Turns und Empfänger-Ack. Kein automatischer Retry bei unbestätigtem Ausgang.
- Neue Feature-Sessions mit separaten ACP-Prozessen; Windows-Job-Object für Launcher-Kindprozesse; Router-basierte Connection-Bereinigung und Close-Watchdog.
- Automatisches Review verwendet erlaubte Team-Reviewer, andere Harnesses bevorzugt, Priorität berücksichtigt. Die vorhandenen drei Korrekturrunden bleiben bestehen.
- MCP-Zugriff auf eigenes Feature begrenzt; Agenten können Planfreigaben weder über Task-Mutation noch über Automation-/Template-/Prompt-Mutation umgehen.
- Git-Integration verweigert ungesicherte Änderungen im Projekt-Checkout, bevor eine Konfliktbereinigung `reset --hard` erreichen kann.

## Nachweise und Baseline

Bun fehlte anfangs; über `npm install --global --allow-scripts=bun bun` installiert (1.4.2). `bun install --frozen-lockfile` erfolgreich. Online-Cargo konnte die zuvor nicht gecachte Git-Abhängigkeit `fix-path-env` beziehen. MSVC/Windows SDK sind vorhanden. Ein RC-Aufruf scheiterte zeitweise; der explizite SDK-Pfad unten behebt das.

Baseline-Frontend: Build bestanden; Vitest 1.569 bestanden/1 fehlgeschlagen. Der bestehende Schedule-Test erwartete ein Datum ohne Locale-Punkt; jetzt akzeptiert er beide Schreibweisen. Separater Commit `762f9bf3`.

Tatsächlich bestanden:

- Frontend-Build nach Einführung der gemeinsamen generierten Typen.
- Vollständiger Vitest-Lauf: **1.573 Tests in 157 Dateien**.
- Tauri-Lib-Tests unter Windows: **366 bestanden, 2 ignoriert**, einschließlich Bindings-Generator, Schutz ungesicherter Git-Änderungen und unveränderter offizieller Projektdateien vor Übernahme.
- Daemon-/Protokoll-Gesamtlauf: **387 Daemon-Unit-Tests, 62 Protokolltests, 16 Daemon-Integrationstests**, einschließlich MCP-Freigabe-/Kontextgrenzen und veralteter Worktree-Basis.
- Echter Daemon/Git-Test: drei Child-Tasks, idempotente Planfreigabe, isolierter Feature-Branch, unverändertes Main, ungültiger Commit abgewiesen.
- Regressionen: leerer Planner-Abschluss, Cancel während Spawn, konkurrierende SQLite-Claims, persistente/deduplizierte Nachrichten, DAG und Freigabe-/Integrationssperren, Windows-Kindprozessbeendigung.
- `cargo check --workspace --locked -j 4` mit explizitem RC-Pfad bestanden.
- Lint bestanden mit **vier bereits vorhandenen React-Purity-Warnungen**; beide Formatprüfungen bestanden. Auch nach den letzten Änderungen bestätigt; E2E-TypeScript-Prüfung zusätzlich bestanden.

Happy-DOM protokolliert weiterhin die bekannten Canvas-/Google-Fonts-Fetch-Abbrüche; Vitest zählt keine fehlgeschlagenen Tests deswegen. Das ist kein Nachweis eines funktionierenden Canvas-Netzwerks.

Reale CLIs liefern Versionen: Claude Code 2.1.293, Codex CLI 0.161.0, Cursor Agent 2026.10.01-e373342. In der Fortsetzung wurden alle drei mit vorhandenen Anmeldungen über echte ACP-Sessions geprüft: Initialize, Spawn, minimaler Prompt, tatsächliche Agent-Antwort und `end_turn`. Das beweist die Connectivity-Voraussetzung von Test A, noch nicht die vollständige Feature-Abnahme. Diese Proben verursachen tatsächliche Provider-Aufrufe.

Windows-GUI-Smoke gegen die echte Debug-App ohne `wdio`: **5 bestanden** (Fenstertitel, Home, lokaler Rechner, IPC/DB, Version). Das erste Release startete wegen einer verbliebenen nativen Updater-Registrierung nicht; Registrierung und Permission sind korrigiert und der GUI-Lauf danach bestand. Der eingebettete Windows-WebDriver scheitert schon beim Kompilieren an inkompatiblen Windows/WebView2-Typen; Windows verwendet deshalb den erfolgreich geprüften externen Tauri-/Edge-Treiber. Der korrigierte Release-Build ohne `wdio` und NSIS-Installer sind bestanden (22,23 MiB). Installation unter `C:\Users\mehme\AppData\Local\MaestroCustomVerification` mit Exit-Code 0; gebündelter Daemon SHA-256 identisch mit Build-Asset, Version `0.35.1-protocol-14`. Installierte App entspricht der Release-Binary bis auf den erwarteten NSIS-Bundle-Marker (`UNK` → `NSS`). Auch gegen die installierte Release-App: **5 GUI-Smoke-Tests bestanden**, Exit-Code 0, Test-Daemon erfolgreich beendet. Screenshot `%TEMP%/maestro-custom-installed-home.png` visuell geprüft. Eine offizielle Maestro-Installation ist auf diesem Rechner nicht vorhanden; tatsächlicher Parallelbetrieb bleibt offen.

## Nächste Schritte in Reihenfolge

1. Aktuelle Fortsetzung: Desktop-/Update-Strecke in `7698e48e`, ACP-/Review-/Kapazitätskorrekturen in `e2a249e0`. Die vorhandene Installation bleibt auf ihrem vorher geprüften Stand; das neue Release liegt separat bereit und wurde nicht installiert. Nach Codeänderungen passende App und Daemon neu bauen; gleichbleibende Versionen allein beweisen keinen identischen Quellstand.
2. Die unten aufgeführten aktuellen Gesamtläufe sind bestätigt. Neue Änderungen gezielt prüfen; vier bestehende Lint-Warnungen getrennt halten.
3. Windows-GUI-Smoke bei Änderungen wiederholen. `bun run test:e2e` baut unter Windows ohne `wdio` und verwendet den externen Treiber. `MAESTRO_E2E_BINARY` kann eine installierte oder Debug-Binary auswählen. `MAESTRO_E2E_SCREENSHOT` speichert einen Screenshot. Die E2E-Konfiguration isoliert Custom-App und Daemon über `MAESTRO_CUSTOM_DATA_DIR`.
4. Fake-ACP-Fixture und Spawn-/Reload-Wire-Regression sind vorhanden. B/C/D vollständig über echte ACP-Sessions prüfen: strukturierte Planübergabe, parallele Starts, menschliche Merge-Gates, integrierte Basis, Rückfrage an denselben Worker, Reviewer-/Rework-Schleife. Das unten dokumentierte reale Feature wartet hierfür auf menschliche Planfreigabe. Wire-Tests allein ersetzen diese Abnahme nicht.
5. Pause/Resume/Cancel vollständig schließen: Pausierte nicht kooperierende Provider zeitlich begrenzt stoppen; beim Resume neue offene Arbeit und verlorene/fehlgeschlagene Turns gezielt fortsetzen. Derzeit öffnet Resume die Startsperre, benötigt aber teilweise manuelles Task-Retry. Terminalprozesse, die der Host für ACP erzeugt, gesondert in die Prozessabnahme aufnehmen.
6. Recovery E: App schließen/öffnen und Daemon töten/neustarten, offene Entscheidungen/Session-Schlüssel/Claims/Integrationen rekonstruieren, kein erneuter Abschluss. Zustellung an inaktive/dormante Sessions muss die vorhandene unterstützte Reload-Strecke nutzen bzw. eine sichtbare Ersatzsession mit Übergabe erstellen. `Submitted` nicht blind wiederholen.
7. Team-Readiness: Installation, geprüfte ACP-Fähigkeiten, Auth und Laufzeitfehler getrennt anzeigen und serverseitig valide Eignung prüfen. Member-Limit/Reviewer-Zuordnung/Orchestrator müssen auch in Harness-/Maschinenlimits einfließen. Aktuelle Feature-/Member-Zählung basiert auf Task-Phasen und ist noch nicht der volle Session-Limit-Nachweis.
8. Feature-Modell/GUI: Priorität, erlaubte Mitglieder als bewusste Auswahl, Dokumente, Meilensteine, Entscheidungslog, Zuordnung bestehender Tasks, strukturierte Findings/Prüfnachweise und Abschlussbericht ergänzen. Eigener kompakter Orchestrator-Chat, Kanban-Gruppierung, Blockierungsgründe und Freigaben fehlen noch.
9. Laufzeit-/Aktionsbudgets sowie höchstens zwei technische Retries bei sicher vorübergehenden Fehlern, gleiche Fehler eskalieren, Auth/Quote/MCP-Secret-Blockaden sichtbar pausieren. Token/Kosten nur bei echten Provider-Daten.
10. Sonderfälle der Integration: NoChanges-Tasks benötigen eine explizite menschliche Bestätigung; PR-Integration muss lokale verfügbare Commit-Basis bestätigen; Reparatur nach erfolgreichem Git-Merge aber fehlgeschlagener DB-Finalisierung muss idempotent und in der GUI erreichbar sein. Kein erneuter unklarer Provider-/Git-Auftrag.
11. Drei reale authentifizierte Harnesses sind jetzt mit minimalen tatsächlichen Provider-Turns geprüft. Installation/Start/gebündelter Windows-Daemon sind geprüft. Getrennter Parallelbetrieb mit offizieller Installation und manuelle Gameplay-/Visual-Akzeptanz bleiben offen.
12. Dokumentation aktualisieren und stabile Fortschritte lokal committen.

## Befehle und Artefakte

```powershell
$env:RC = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\rc.exe'
$env:MAESTRO_TEST_MANIFEST = '1'
cargo test -p maestro --lib -j 4
Remove-Item Env:MAESTRO_TEST_MANIFEST
cargo test -p maestro-server -p maestro-protocol -j 4
cargo check --workspace --locked -j 4
bun run build
bun run test --run
bun run lint
bun run format
bun run format:rust
bun run tauri build --bundles nsis
```

Installer: `target/release/bundle/nsis/Maestro Custom_0.35.1_x64-setup.exe`, SHA-256 `C36E46A0E294B987D4C337C13427E6FF015AD2511C132093332B8B1D796CC00D`. Installierte App: `C:\Users\mehme\AppData\Local\MaestroCustomVerification\maestro.exe`. Keine drei Harnesses und kein vollständiges Feature-Beispiel behaupten.

Logs des aktuellen Laufs liegen unter `%TEMP%/maestro-custom-*.log`, insbesondere `release2`, `e2e-build`, `rust-verified`, `rust-complete-check`, `tauri-verified`, `vitest-final`, `basis-test`, `mcp-gates`, `check-final`. Keine Credentials in Logs schreiben. Globale Custom-Daten nicht als Testdaten löschen. Zwei ältere temporäre Testverzeichnisse (`%TEMP%/maestro-e2e-xaX7qW` und `maestro-e2e-JxRL9c`) können noch bestehen; ihre Test-Daemons sind beendet. Die automatische Freigabeprüfung blockierte das manuelle Löschen des ersten Verzeichnisses ohne nähere Begründung. Der letzte E2E-Cleanup bestand.

Codegraph-Tool war in dieser Sitzung nicht verfügbar; vor einer Fortsetzung erneut verfügbare Tools prüfen. Repository-/Domain-`AGENTS.md` und `docs/automations-plan.md` beachten. Migrationen anhängen, Bindings generieren, keine `CLAUDE.md` hinzufügen.

# Fortsetzung 09.10.2026: Desktop und Kommunikation

Die vorhandene Installation ist weiter nutzbar; sie wurde nicht erneut installiert.
Startmenü: **Maestro Custom**, Ziel
`C:\Users\mehme\AppData\Local\MaestroCustomVerification\maestro.exe`.
Installierte App und **Maestro Custom – Dev** wurden tatsächlich gleichzeitig gestartet.
Desktop-/Startmenü-Verknüpfungen für Dev und Update sind eingerichtet.
`scripts/Setup-MaestroCustomShortcuts.ps1` stellt sie bei Bedarf wieder her.

Dev nutzt `.maestro/custom-dev-data` mit eigenem Daemon und Binärcache. Vite-HMR
für die sichtbare Custom-Bezeichnung und Tauri-Rust-Neukompilierung wurden im laufenden
Dev-Log nachgewiesen. Der Daemon-Watcher baut geänderte Quellen, fragt bei offenen
Sessions/Automationen vor dem Austausch und erhält bei Fehlern die bisherigen Assets.
Windows-Probleme beim Beobachten von `target/debug/*.dll`, mehrfachen gleichzeitigen
Starts, abgestürzten Daemon-Runtime-Dateien und bereits beendeten `taskkill`-Kindprozessen
sind berücksichtigt. Ein noch laufendes Testprogramm kann unter Windows die Debug-Exe
gegen Neubauen sperren; die echten Harness-Tests verwenden deshalb eine isolierte Kopie.

`bun run custom:build` baut nur den Installer; `custom:update` fragt nach erfolgreichem
Build und SHA-256-Anzeige ausdrücklich vor Installation und Session-Unterbrechung.
Der neue Release-Build und NSIS-Bundle sind erfolgreich abgeschlossen; die zusätzliche
Kapazitätskorrektur wird vor dem abschließenden Bundle erneut geprüft. Der neue Installer
wurde nicht installiert. Installation erfordert die separate menschliche Bestätigung.

Bestanden in dieser Fortsetzung:

- Echter Windows-GUI-Test gegen die installierte Anwendung: drei Profile als Teammitglieder,
  Feature-Erstellung, App-Prozessneustart, gespeichertes Feature wieder öffnen und abbrechen.
  Log: `%TEMP%/maestro-custom-gui-orchestration7.log`. Screenshots: `maestro-custom-agent-team.png`
  und `maestro-custom-feature.png` im TEMP-Verzeichnis. Kein bezahlter Feature-Turn in diesem Test.
- Sechs Node-Tests für authentifizierte Daemon-Frames, fragmentierte Antworten, Pushes,
  Verbindungsverlust, oversized Frames, Snapshot-Antworten und eine absolute Frist trotz
  kontinuierlicher Pushes. Aufruf: `node --test scripts/custom-desktop.test.mjs`.
- Frontend: 1573 Tests / 157 Dateien. Lint: nur die vier vorher bekannten React-Purity-Warnungen.
- Daemon nach Worker-Kontext-/Review-Gate-/Spawn-/Kapazitäts-Ergänzungen: 391 Unit-Tests,
  62 Protokolltests und 17 Wire-Integrationstests. Der Wire-Lauf wurde mit einem eigenen
  Daemon-Verzeichnis pro Test erneut bestanden. Gesamtlauf:
  `%TEMP%/maestro-custom-final-server-tests.log`.
- Neue Release-App ohne `wdio`: beide echten Windows-GUI-Dateien bestanden,
  fünf Smoke-Assertions plus Team-/Feature-/App-Neustart-Test.
  `%TEMP%/maestro-custom-release-gui-latest.log` (2:31 Minuten).

Die erste reale ACP-Probe reproduzierte Claudes `unknown session` unmittelbar nach
`SpawnOk`. Ursache: Erfolgsantwort vor Registrierung im Dispatch-Loop. Spawn und Reload
registrieren die Session jetzt über die vorhandene Settle-Strecke vor der Antwort.
Ein bestandener Fake-ACP-Wire-Test prüft 20 sofortige Spawn-/Prompt- und Reload-/Prompt-Paare.
Danach bestanden Codex (`codex-acp`), Claude (`claude-acp`) und Cursor (`cursor`) echte
authentifizierte ACP-Turns. Der abschließende isolierte Lauf ist dokumentiert in
`%TEMP%/maestro-custom-real-harness-isolated2.log`, Ergebnisse in
`%TEMP%/maestro-real-harness-kZQBKN/results.json`. Die Antwortvalidierung zählt nur
verkettete Agent-Text-Chunks. Ein Zwischentest mit falschen Registry-IDs `codex`/`claude`
scheiterte erwartungsgemäß und ist kein Harness-Fehler.

Worker-/Reviewer-Prompts erhalten jetzt Feature-ID, Ziel, Akzeptanz und MCP-Anweisungen
für Rückfragen, Feedback und Acknowledgements in derselben Session. Ein unlesbares Review
eines Feature-Tasks wird als fehlgeschlagener Review behandelt; es gibt weder Freigabe noch
eine auf Verdacht bezahlte Korrekturrunde. Legacy-Task-Verhalten bleibt erhalten.

Team-Kapazität wird jetzt nach dem tatsächlich verwendeten Profil gezählt: Review inklusive
Spawn gegen den Reviewer, Orchestrator gegen seinen Team-Eintrag, blockierte laufende Turns
belegen weiterhin Kapazität. Der Regressionstest umfasst zwei konkurrierende Reviews,
eine parallele Orchestrator-Session desselben Profils und den Ausschluss des eigenen Claims.
Idle/dormante Sessions und zusätzliche explizite Harness-Limits sind damit noch nicht vollständig
abgedeckt; die bestehenden Maschinenlimits bleiben zusätzlich wirksam.

Weiter offen: vollständiger mehrstufiger ACP-Feature-Lauf mit echten unterschiedlichen
Workern, unabhängiger Review-Korrekturschleife, Rückfrage/Antwort und Wiederaufnahme nach
Daemon-Neustart; konfigurierbare Ausführungsbudgets, Dormant-Session-Kommunikation und die
weiter unten aufgeführten Grenzen. Drei Connectivity-Proben allein sind kein vollständiger
Multi-Agent-Workflow-Nachweis. Der Branch ist remote nicht vorhanden; es wurde nichts gepusht.
Die früher blockierten temporären Verzeichnisse wurden nicht manuell gelöscht.

## Reales Feature: konkreter Fortsetzungspunkt

`scripts/prepare-feature-acceptance.mjs --plan` hat ein eigenes temporäres Git-Projekt
angelegt und einen echten Codex-Planner über den Dev-Daemon gestartet. Das Ergebnis ist
ein persistenter validierter Plan mit drei Aufgaben im Status **AwaitingApproval**.
Die menschliche Planfreigabe wurde im Chat angefragt und ist noch ausstehend.
Keine Worker wurden ohne diese Freigabe gestartet.

Nach dem Dev-App- und Dev-Daemon-Neustart wurde derselbe Snapshot erneut über die
authentifizierte Schnittstelle gelesen: `AwaitingApproval`, drei geplante Aufgaben,
keine gestarteten Child-Tasks. Das beweist Plan-Persistenz, nicht die Wiederaufnahme
eines bereits laufenden Worker-Turns. Beide Desktop-Fenster sind weiter geöffnet.

- Projekt: `C:/Users/mehme/AppData/Local/Temp/maestro-feature-acceptance-tTNKAH`.
- Feature: `588c7585-f479-4c4d-b976-ce38e925e2e7`, Orchestrator-Task 1.
- Manifest: `.maestro/custom-dev-data/feature-acceptance.json` (der Snapshot im Daemon
  ist für den aktuellen Status maßgeblich; das Manifest hält die Erstellungsdaten).
- Plan: Claude implementiert Summe und stellt eine Rückfrage; Cursor implementiert
  unabhängig Produkt. Für den Review-Nachweis enthält Claudes erste Runde eine ausdrücklich
  deklarierte Fehlereinfügung. Ein separater Codex-Reviewer soll den Fehler zurückgeben.
  Cursor führt anschließend beide Ergebnisse zusammen, erst nach menschlicher Freigabe
  und tatsächlich bestätigter Integration beider Voraussetzungen.

Nach menschlicher Planfreigabe gezielt `approve_plan` für genau dieses Feature senden.
Worker-Turns, Rückfrage, Antwort, Review und Rework beobachten und Prüfbelege sichern.
Vor jeder Integration die konkreten Commits/Diffs präsentieren und Freigabe einholen.
Main bleibt unverändert. Dieser Planner-Lauf wurde über die Daemon-Schnittstelle gestartet;
der separate GUI-Test belegt die GUI-Einstiege, noch keinen zusammenhängenden realen GUI-Lauf.
