# Maestro Custom – Orchestrierung

Diese Implementierung erweitert den Fork auf `codex/custom-orchestration`. Sie ist eine ausführbare Grundlage, noch keine vollständig abgenommene Produktionsplattform. Die verbindlichen Abnahmetests A–G sind noch nicht vollständig nachgewiesen. Der genaue Arbeitsstand und die nächsten Schritte stehen in `custom-orchestration-progress.md`.

## Bedienung

1. Projekt in Maestro Custom öffnen. Bei vorhandenen `.maestro`-Daten verlangt die Oberfläche eine ausdrückliche Übernahmebestätigung. Vorher alle offiziellen Maestro-Sessions dieses Projekts schließen. App-Daten und Secrets werden nicht automatisch importiert.
2. Unter Project Settings → Agents bestehende Profile konfigurieren und als Agent Team hinzufügen. Profile bleiben die Quelle für Harness, Modell, Effort, Berechtigungen, Skills und MCP-Konfiguration. Rollen, Stärken, Aktivierung und Session-Limit gehören zum Teammitglied. Ein unbekannter Installations-/Anmeldestatus ist kein Bereitschaftsnachweis.
3. Über **Features / New Feature** Ziel, Akzeptanzkriterien, Orchestrator, Basisbranch und Parallelität angeben. Standardmäßig sind zwei Worker erlaubt. Aktivierte Worker/Reviewer bilden die erlaubte Auswahl.
4. **Start planning** öffnet einen Planner-Turn mit den Orchestrierungswerkzeugen. Die bestehende Task-Detailansicht zeigt die Orchestrator-Session und deren Verlauf. Ein fehlender strukturierter Feature-Plan blockiert die Planung.
5. Den vorgeschlagenen Plan prüfen und **Approve plan and start workers** auswählen. Die Übernahme erzeugt Child-Tasks und gerichtete Abhängigkeiten in einer Transaktion. Wiederholtes Bestätigen desselben Plans erzeugt keine Duplikate.
6. Worker über die vorhandenen Task-, Session-, Log-, Diff- und Review-Ansichten verfolgen. Jeder Merge braucht den bestehenden menschlichen Freigabedialog. Feature-Ergebnisse landen auf `codex/feature-<UUID>`; der Feature-Workflow führt keinen Main-Merge aus.
7. Ein abhängiger Worker wartet auf abgeschlossene Voraussetzungen **und** einen gespeicherten, im Feature-Branch verifizierten Integrations-Commit. Commit-only zählt nicht als Integration.
8. Nachrichten im Feature-Dialog senden. Der Orchestrator kann einem konkreten Worker über MCP antworten. Nachrichten warten während aktiver Turns und werden bei einem freien Turn derselben Session zugestellt. `Submitted` bedeutet Übergabe, `Ack` bestätigte Verarbeitung. Bei unklarem Provider-Ausgang gibt es keine automatische Wiederholung. **Retry delivery** ist eine bewusste menschliche Wiederholung und kann Provider-Arbeit wiederholen.
9. Pause sperrt neue Starts und sendet ACP-Cancellation an aktive Turns. Resume öffnet die Startsperre. Fehlgeschlagene oder verlorene Sessions benötigen derzeit gegebenenfalls einen gezielten Task-Retry über die vorhandene Oberfläche. Cancel sperrt alle Feature-Starts und schließt zugehörige Sessions. Der Abschluss braucht **complete** und erfolgreich integrierte Tasks.

## Architektur und Speicherung

Die bestehende Task-Pipeline und deren Scheduler bleiben verantwortlich für Planung, Worker, Review/Rework und Kapazität. Features ergänzen diese Pipeline; es gibt keinen zweiten Scheduler und kein LLM-Polling. Koaleszierte Daemon-Benachrichtigungen stoßen die Nachrichtenzustellung an. Bestehende `TasksChanged`-Pushes invalidieren zusätzlich die TanStack-Query-Daten der Orchestrierung.

`maestro-protocol/src/orchestration.rs` enthält die gemeinsamen Team-, Feature-, Plan- und Nachrichtentypen. Der optionale `bindings`-Build exportiert die Typen durch den vorhandenen Tauri/Specta-Generator. `src/types/bindings.ts` wird ausschließlich generiert. Das Protokoll ist Version 14.

Append-only-Migrationen in `maestro-server/src/project_store.rs`:

- **v10:** `agent_team`, `features`, `feature_tasks`, `orchestration_messages`.
- **v11:** `feature_integrations` mit Commit und Freigabezeitpunkt.

Team und Feature-Konfiguration liegen als versionierbare JSON-Bodies im projektbezogenen Namensraum des daemonseitigen `projects.db`. Task-Zuordnungen und Nachrichten besitzen relational geprüfte Fremdschlüssel. Planübernahme und Beziehungen sind atomar. Nachrichtenschlüssel sind je Projekt/Feature eindeutig. Turn-Ergebnis und dazugehörige Fortschrittsnachricht werden gemeinsam gespeichert. Projektregeln und Task-Instruktionen werden über die bestehende Prompt-Komposition eingebunden.

`blocks` bedeutet Voraussetzung → abhängiger Task. Selbstbezüge und Zyklen werden abgewiesen. Queue-Auswahl, Start-Claim und Session-Fertigmeldung prüfen die Feature-Sperren. Die Claim-Prüfung prüft Voraussetzungen erneut innerhalb der Task-Transaktion. Feature-Tasks dürfen ihre Integration nicht durch bloße Statusänderungen freischalten.

Die neuen MCP-Werkzeuge sind `get_feature_context`, `submit_feature_plan`, `send_feature_message` und `acknowledge_feature_message`. Identität und Projekt stammen aus der authentifizierten Session-Bindung. Worker können nur dem eigenen Orchestrator schreiben; direkte Worker-Kommunikation ist gesperrt. Feature-Agenten dürfen `create_task`/`update_task` nicht zum Umgehen der menschlichen Planfreigabe benutzen. Benutzeraktionen und Agentenaktionen werden serverseitig unterschieden.

Neue Feature-Turns besitzen dedizierte ACP-Prozesse. Die Cleanup-Logik sucht die konkrete Verbindung anhand des Routers, sodass andere Features ihre Verbindungen behalten. Unter Windows hält ein Job Object den Launcher und seine Kindprozesse zusammen. Der Close-Watchdog beendet einen hängenden Transport und wartet auf das Ende seiner Task. Dies ersetzt noch keinen vollständigen Abnahmenachweis für alle Provider und vom Host erzeugten Terminalprozesse.

## Fork-Isolation und Windows

- Produkt: **Maestro Custom**; App-ID: `com.memocan040.maestro.custom`.
- Overrides heißen `MAESTRO_CUSTOM_DATA_DIR` und `MAESTRO_CUSTOM_DAEMON_DIR`; offizielle Maestro-Overrides werden bewusst ignoriert.
- Globale Daemon-/Agent-/MCP-/Skill-Daten: `~/.maestro-custom`; Projektkonfiguration weiterhin `.maestro`.
- Keychain: `maestro-custom.ticketing` und `maestro-custom.mcp`.
- Lokaler Daemon-Launcher: `~/.local/bin/maestro-custom-server.exe`; entfernte Launcher analog getrennt.
- Autostart-Einträge verwenden die Custom-App-ID bzw. `maestro-custom-server.service` und einen eigenen Cron-Marker.
- Offizielle App-Updates und Server-Downloads sind deaktiviert. Daemons kommen ausschließlich aus `server-assets` und werden vor Deployment auf ihre App-/Protokollversion geprüft.

In PowerShell im Repository:

```powershell
bun install --frozen-lockfile
$env:RC = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\rc.exe'
bun run tauri build --bundles nsis
```

Den SDK-Pfad an die tatsächlich installierte Windows-SDK-Version anpassen. `server:bundle` baut den eigenen Release-Daemon und kopiert ihn nach `src-tauri/server-assets`. Der Tauri-Build verpackt ihn mit der App. Zusätzliche SSH-/WSL-/Docker-Zielarchitekturen müssen selbst gebaut und als passende Assets bereitgestellt werden; die App lädt keinen offiziellen Ersatz herunter. Nicht mit `wdio` ausliefern.

Für Tauri-Lib-Tests:

```powershell
$env:MAESTRO_TEST_MANIFEST = '1'
cargo test -p maestro --lib -j 4
```

Für einen App-Build diese Variable entfernen. Development verwendet denselben Asset-Staging-Pfad: zuerst `bun run server:bundle`, dann `bun run tauri:dev` (dessen Unix-Shell-Skript unter PowerShell gegebenenfalls durch `bun run tauri dev` ersetzen).

## Noch offene Grenzen

Es fehlen insbesondere vollständige Bereitschafts-/Auth-Anzeigen im Team, Dokumentreferenzen/Meilensteine, gezielte Zuordnung bestehender Tasks, separate strukturierte Entscheidungen/Review-Findings/Prüfnachweise, Ausführungsbudgets, zusätzliche Harness-Limits, technische Retry-/Eskalationsregeln, verlässliches automatisches Wiederanlaufen jeder pausierten oder verlorenen Session und vollständiger Nachrichten-Replay nach Daemon-Neustart. Die bestehenden drei Review-Korrekturrunden werden weiterverwendet. Reviewer werden aus erlaubten, aktivierten Teammitgliedern nach Priorität gewählt; ein anderer Harness wird bevorzugt. Ein fehlender Reviewer führt zur menschlichen Prüfung.

Persistenztests beweisen gespeicherte Daten und idempotente Plan-/Nachrichtenoperationen; sie beweisen noch nicht den vollständigen ACP-Recovery-Ablauf A–G. Die GUI verweist auf bestehende Task-Sessions, bietet aber noch keinen vollständigen eingebetteten Projekt-Orchestrator-Chat oder Kanban-Gruppierung. Kosten-/Tokenanzeigen werden nicht geschätzt.

## Konfliktanfällige Upstream-Bereiche

Bei Upstream-Merges besonders prüfen: `task_store`/Lifecycle-Guards und Queue-SQL, `task_runner`/`task_turn`, ACP-Verbindungs-Pooling und Recovery, MCP-Manifest/Gateway, Protokoll-Enums, Daemon-Migrationen, Tauri-Command-Registrierung/Bindings, Git-Merge-Finalisierung, Deployment/Updater sowie Kanban-/Settings-Einbindung. Neue Migrationen immer anhängen; keine ausgelieferte Migration bearbeiten. Bindings nach dem Merge neu generieren und beide Formatprüfungen ausführen.
