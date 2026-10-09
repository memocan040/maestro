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
- Tauri-Lib-Tests unter Windows: **364 bestanden, 2 ignoriert**, einschließlich Bindings-Generator und Schutz ungesicherter Git-Änderungen.
- Daemon-/Protokoll-Gesamtlauf: **385 Daemon-Unit-Tests, 62 Protokolltests, 16 Daemon-Integrationstests**. Danach zusätzlich einzeln bestanden: MCP-Freigabe-/Kontextgrenzen und veraltete Worktree-Basis. Gesamtstand enthält deshalb 387 Daemon-Unit-Tests; abschließenden Gesamtlauf nach diesen Ergänzungen noch bestätigen.
- Echter Daemon/Git-Test: drei Child-Tasks, idempotente Planfreigabe, isolierter Feature-Branch, unverändertes Main, ungültiger Commit abgewiesen.
- Regressionen: leerer Planner-Abschluss, Cancel während Spawn, konkurrierende SQLite-Claims, persistente/deduplizierte Nachrichten, DAG und Freigabe-/Integrationssperren, Windows-Kindprozessbeendigung.
- `cargo check --workspace --locked -j 4` mit explizitem RC-Pfad bestanden.
- Lint bestanden mit **vier bereits vorhandenen React-Purity-Warnungen**; beide Formatprüfungen bestanden. Nach letzten Änderungen erneut prüfen.

Happy-DOM protokolliert weiterhin die bekannten Canvas-/Google-Fonts-Fetch-Abbrüche; Vitest zählt keine fehlgeschlagenen Tests deswegen. Das ist kein Nachweis eines funktionierenden Canvas-Netzwerks.

Reale CLIs liefern Versionen: Claude Code 2.1.293, Codex CLI 0.161.0, Cursor Agent 2026.10.01-e373342. **Keine drei authentifizierten ACP-Harnesses verifiziert; Test A bleibt offen.** Keine Provider-Aufträge mit zusätzlichem Modellverbrauch ausgeführt.

Windows-Release-/GUI-Builds laufen bzw. deren Ergebnis ist unten nachzutragen. Ein laufender Build zählt nicht als bestanden. Die GUI-E2E-Prüfung, Installation und Parallelbetrieb mit offiziellem Maestro sind noch nicht nachgewiesen.

## Nächste Schritte in Reihenfolge

1. Laufende Builds/Logs auswerten. Den letzten Quellstand erneut als Release ohne `wdio` bauen, weil während des ersten Cold-Builds weitere Schutzprüfungen entstanden sind. Daemon-Asset muss zum letzten Stand passen. Installer erst nach erfolgreichem Build als Ergebnis nennen.
2. Gesamtläufe für Rust, Frontend, Lint und beide Formatprüfungen bestätigen. Neue Probleme beheben; alte Warnungen getrennt halten.
3. Echte Windows-GUI-Smoke-Tests gegen die mit `wdio` gebaute **Debug**-Binary ausführen. `MAESTRO_E2E_BINARY` explizit auf `target/debug/maestro.exe` setzen. Release-Binary niemals mit `wdio` ausliefern. Die E2E-Konfiguration erstellt temporäre App-Daten.
4. Einen deterministischen Fake-ACP-Agenten als Test-Fixture bauen und B/C/D vollständig über echte ACP-Sessions prüfen: strukturierte Planübergabe, parallele Starts, menschliche Merge-Gates, integrierte Basis, Rückfrage an denselben Worker, Reviewer-/Rework-Schleife. Vorhandener Wire-Test bildet nur einen Teil von B ab und ersetzt diese Tests nicht.
5. Pause/Resume/Cancel vollständig schließen: Pausierte nicht kooperierende Provider zeitlich begrenzt stoppen; beim Resume neue offene Arbeit und verlorene/fehlgeschlagene Turns gezielt fortsetzen. Derzeit öffnet Resume die Startsperre, benötigt aber teilweise manuelles Task-Retry. Terminalprozesse, die der Host für ACP erzeugt, gesondert in die Prozessabnahme aufnehmen.
6. Recovery E: App schließen/öffnen und Daemon töten/neustarten, offene Entscheidungen/Session-Schlüssel/Claims/Integrationen rekonstruieren, kein erneuter Abschluss. Zustellung an inaktive/dormante Sessions muss die vorhandene unterstützte Reload-Strecke nutzen bzw. eine sichtbare Ersatzsession mit Übergabe erstellen. `Submitted` nicht blind wiederholen.
7. Team-Readiness: Installation, geprüfte ACP-Fähigkeiten, Auth und Laufzeitfehler getrennt anzeigen und serverseitig valide Eignung prüfen. Member-Limit/Reviewer-Zuordnung/Orchestrator müssen auch in Harness-/Maschinenlimits einfließen. Aktuelle Feature-/Member-Zählung basiert auf Task-Phasen und ist noch nicht der volle Session-Limit-Nachweis.
8. Feature-Modell/GUI: Priorität, erlaubte Mitglieder als bewusste Auswahl, Dokumente, Meilensteine, Entscheidungslog, Zuordnung bestehender Tasks, strukturierte Findings/Prüfnachweise und Abschlussbericht ergänzen. Eigener kompakter Orchestrator-Chat, Kanban-Gruppierung, Blockierungsgründe und Freigaben fehlen noch.
9. Laufzeit-/Aktionsbudgets sowie höchstens zwei technische Retries bei sicher vorübergehenden Fehlern, gleiche Fehler eskalieren, Auth/Quote/MCP-Secret-Blockaden sichtbar pausieren. Token/Kosten nur bei echten Provider-Daten.
10. Sonderfälle der Integration: NoChanges-Tasks benötigen eine explizite menschliche Bestätigung; PR-Integration muss lokale verfügbare Commit-Basis bestätigen; Reparatur nach erfolgreichem Git-Merge aber fehlgeschlagener DB-Finalisierung muss idempotent und in der GUI erreichbar sein. Kein erneuter unklarer Provider-/Git-Auftrag.
11. Drei reale installierte Harnesses für A ohne zusätzliche Kosten/Anmeldung prüfen; falls das nicht möglich ist, konkreten Blocker melden. Windows-Installation/Start, gebündelten Daemon und getrennten Parallelbetrieb tatsächlich prüfen. Manuelle Gameplay-/Visual-Akzeptanz separat behandeln.
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

Logs des aktuellen Laufs liegen unter `%TEMP%/maestro-custom-*.log`, insbesondere `release2`, `e2e-build`, `rust-verified`, `rust-complete-check`, `tauri-verified`, `vitest-final`, `basis-test`, `mcp-gates`, `check-final`. Keine Credentials in Logs schreiben. Globale Custom-Daten nicht als Testdaten löschen.

Codegraph-Tool war in dieser Sitzung nicht verfügbar; vor einer Fortsetzung erneut verfügbare Tools prüfen. Repository-/Domain-`AGENTS.md` und `docs/automations-plan.md` beachten. Migrationen anhängen, Bindings generieren, keine `CLAUDE.md` hinzufügen.
