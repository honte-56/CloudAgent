<div align="center">
 <img src="../public/logo.svg" alt="CloudAgent" width="64" height="64">
 <h1>CloudAgent</h1>
 <p>Eine Desktop- und Mobile-Oberfläche für <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>, <a href="https://docs.cursor.com/en/cli/overview">Cursor CLI</a> und <a href="https://developers.openai.com/codex">Codex</a>.<br>Lokal oder remote nutzbar – verwalte deine aktiven Projekte und Sitzungen von überall.</p>
</div>

CloudAgent is derived from [CloudCLI / Claude Code UI](https://github.com/siteboon/claudecodeui). References to CloudCLI Cloud, third-party plugins, and upstream documentation still refer to those original services.

<div align="right"><i><a href="../README.md">English</a> · <a href="./README.ru.md">Русский</a> · <b>Deutsch</b> · <a href="./README.ko.md">한국어</a> · <a href="./README.zh-CN.md">简体中文</a> · <a href="./README.zh-TW.md">繁體中文</a> · <a href="./README.ja.md">日本語</a> · <a href="./README.tr.md">Türkçe</a> · <a href="./README.id.md">Bahasa Indonesia</a></i></div>

---

## Screenshots

<div align="center">

<table>
<tr>
<td align="center">
<h3>Desktop-Ansicht</h3>
<img src="../public/screenshots/desktop-main.png" alt="Desktop-Oberfläche" width="400">
<br>
<em>Hauptoberfläche mit Projektübersicht und Chat</em>
</td>
<td align="center">
<h3>Mobile-Erfahrung</h3>
<img src="../public/screenshots/mobile-chat.png" alt="Mobile-Oberfläche" width="250">
<br>
<em>Responsives mobiles Design mit Touch-Navigation</em>
</td>
</tr>
<tr>
<td align="center" colspan="2">
<h3>CLI-Auswahl</h3>
<img src="../public/screenshots/cli-selection.png" alt="CLI-Auswahl" width="400">
<br>
<em>Wähle zwischen Claude Code, Cursor CLI und Codex</em>
</td>
</tr>
</table>



</div>

## Funktionen

- **Responsives Design** – Funktioniert nahtlos auf Desktop, Tablet und Mobilgerät, sodass du Agents auch vom Smartphone aus nutzen kannst
- **Interaktives Chat-Interface** – Eingebaute Chat-Oberfläche für die reibungslose Kommunikation mit den Agents
- **Integriertes Shell-Terminal** – Direkter Zugriff auf die Agents CLI über die eingebaute Shell-Funktionalität
- **Datei-Explorer** – Interaktiver Dateibaum mit Syntaxhervorhebung und Live-Bearbeitung
- **Git-Explorer** – Änderungen anzeigen, stagen und committen. Branches wechseln ebenfalls möglich
- **Sitzungsverwaltung** – Gespräche fortsetzen, mehrere Sitzungen verwalten und Verlauf nachverfolgen
- **Plugin-System** – CloudAgent mit eigenen Plugins erweitern – neue Tabs, Backend-Dienste und Integrationen hinzufügen. [Eigenes Plugin erstellen →](https://github.com/cloudcli-ai/cloudcli-plugin-starter)
- **TaskMaster AI Integration** *(Optional)* – Erweitertes Projektmanagement mit KI-gestützter Aufgabenplanung, PRD-Parsing und Workflow-Automatisierung
- **Modell-Kompatibilität** – Funktioniert mit den Claude- und GPT-Modellfamilien (vollständige Liste unterstützter Modelle zur Laufzeit über `GET /api/providers/:provider/models`)


## Schnellstart

Requires Node.js 22 or later. Install CloudAgent from this repository:

```bash
git clone https://github.com/honte-56/CloudAgent.git
cd CloudAgent
npm ci
npm run build
npm run server
```

Open `http://localhost:3001`. For development, run `npm run dev`.

After building, use `npm link` to enable the `cloudagent` command; `cloudcli` remains a compatibility alias. The package name is `@honte-56/cloudagent`; this rename does not publish an npm package, so use the source installation above.

Build the desktop app with `npm run desktop:pack`. Published artifacts belong on [GitHub Releases](https://github.com/honte-56/CloudAgent/releases). Docker templates still install upstream CloudCLI images.

Existing `~/.cloudcli` and `~/.claude-code-ui` data directories and `CLOUDCLI_*` environment variables remain compatible.

## Sicherheit & Tool-Konfiguration

**🔒 Wichtiger Hinweis**: Alle Claude Code Tools sind **standardmäßig deaktiviert**. Dies verhindert, dass potenziell schädliche Operationen automatisch ausgeführt werden.

### Tools aktivieren

Um den vollen Funktionsumfang von Claude Code zu nutzen, müssen Tools manuell aktiviert werden:

1. **Tool-Einstellungen öffnen** – Klicke auf das Zahnrad-Symbol in der Seitenleiste
2. **Selektiv aktivieren** – Nur die benötigten Tools einschalten
3. **Einstellungen übernehmen** – Deine Einstellungen werden lokal gespeichert

<div align="center">

![Tool-Einstellungen Modal](../public/screenshots/tools-modal.png)
*Tool-Einstellungen – nur aktivieren, was benötigt wird*

</div>

**Empfohlene Vorgehensweise**: Mit grundlegenden Tools starten und bei Bedarf weitere hinzufügen. Die Einstellungen können jederzeit angepasst werden.

---

## Plugins

CloudAgent verfügt über ein Plugin-System, mit dem benutzerdefinierte Tabs mit eigener Frontend-UI und optionalem Node.js-Backend hinzugefügt werden können. Plugins können direkt in **Einstellungen > Plugins** aus Git-Repos installiert oder selbst entwickelt werden.

### Verfügbare Plugins

| Plugin | Beschreibung |
|---|---|
| **[Project Stats](https://github.com/cloudcli-ai/cloudcli-plugin-starter)** | Zeigt Dateianzahl, Codezeilen, Dateityp-Aufschlüsselung, größte Dateien und zuletzt geänderte Dateien des aktuellen Projekts |
| **[Web Terminal](https://github.com/cloudcli-ai/cloudcli-plugin-terminal)** | Vollwertiges xterm.js-Terminal mit Multi-Tab-Unterstützung |
| **[CloudCLI Scheduler](https://github.com/grostim/cloudcli-cron)** | Erstellt arbeitsbereichsbezogene geplante Prompts und führt sie über eine lokale CLI wie Codex oder Claude Code aus |
| **[PRISM CloudCLI](https://github.com/jakeefr/cloudcli-plugin-prism)** | Sitzungsintelligenz für Claude Code in CloudAgent, inklusive Sichtbarkeit des Token-Verbrauchs |
| **[Sessions](https://github.com/strykereye2/cloudcli-plugin-session-manager)** | Aktive Claude-Code-Sitzungen anzeigen, verwalten und beenden |
| **[Token Cost Calculator](https://github.com/NightmareAway/cloudcli-plugin-token-cost-calculator)** | API-Kosten anhand von Modellpreisen und Token-Nutzung berechnen, mit Unterstützung für Preisvorlagen |
| **[Task Queue](https://github.com/TadMSTR/cloudcli-plugin-task-queue)** | Task-Queue-Dashboard zum Anzeigen, Filtern und Starten von Agent-Aufgaben |
| **[GitHub Issues Board](https://github.com/szmidtpiotr/claude-github-issue)** | Kanban-Board für GitHub Issues mit bidirektionaler TaskMaster-Synchronisierung und automatischer Installation des /github-task CLI-Skills |
| **[ccx](https://github.com/AaronWong1999/cloudcli-plugin-ccx)** | Zeigt die Claude- und Codex-Nutzung und übergibt die geöffnete Sitzung samt Gesprächsverlauf an den anderen Agenten (macOS, benötigt ccx) |

### Eigenes Plugin erstellen

**[Plugin-Starter-Vorlage →](https://github.com/cloudcli-ai/cloudcli-plugin-starter)** – Forke dieses Repository, um ein eigenes Plugin zu erstellen. Es enthält ein funktionierendes Beispiel mit Frontend-Rendering, Live-Kontext-Updates und RPC-Kommunikation zu einem Backend-Server.

**[Plugin-Dokumentation →](https://cloudcli.ai/docs/plugin-overview)** – Vollständige Anleitung zur Plugin-API, zum Manifest-Format, zum Sicherheitsmodell und mehr.

---
## FAQ

<details>
<summary>Wie unterscheidet sich das von Claude Code Remote Control?</summary>

Claude Code Remote Control ermöglicht es, Nachrichten an eine bereits im lokalen Terminal laufende Sitzung zu senden. Der Rechner muss eingeschaltet bleiben, das Terminal muss offen bleiben, und Sitzungen laufen nach etwa 10 Minuten ohne Netzwerkverbindung ab.

CloudAgent und CloudCLI Cloud erweitern Claude Code, anstatt neben ihm zu laufen – MCP-Server, Berechtigungen, Einstellungen und Sitzungen sind exakt dieselben, die Claude Code nativ verwendet. Nichts wird dupliziert oder separat verwaltet.

Das bedeutet in der Praxis:

- **Alle Sitzungen, nicht nur eine** – CloudAgent erkennt automatisch jede Sitzung aus dem `~/.claude`-Ordner. Remote Control stellt nur die einzelne aktive Sitzung bereit, um sie in der Claude Mobile App verfügbar zu machen.
- **Deine Einstellungen sind deine Einstellungen** – MCP-Server, Tool-Berechtigungen und Projektkonfiguration, die in CloudAgent geändert werden, werden direkt in die Claude Code-Konfiguration geschrieben und treten sofort in Kraft – und umgekehrt.
- **Funktioniert mit mehr Agents** – Claude Code, Cursor CLI und Codex, nicht nur Claude Code.
- **Vollständige UI, nicht nur ein Chat-Fenster** – Datei-Explorer, Git-Integration, MCP-Verwaltung und ein Shell-Terminal sind alle eingebaut.
- **CloudCLI Cloud läuft in der Cloud** – Laptop zuklappen, der Agent läuft weiter. Kein Terminal zu überwachen, kein Rechner, der laufen muss.

</details>

<details>
<summary>Muss ich ein KI-Abonnement separat bezahlen?</summary>

Ja. CloudAgent stellt die Umgebung bereit, nicht die KI. Du bringst dein eigenes Claude-, Cursor- oder Codex-Abonnement mit. CloudCLI Cloud beginnt bei €7/Monat für die gehostete Umgebung zusätzlich dazu.

</details>

<details>
<summary>Kann ich CloudAgent auf meinem Smartphone nutzen?</summary>

Ja. Bei Self-Hosted: Server auf dem eigenen Rechner starten und `[deineIP]:port` in einem beliebigen Browser im Netzwerk öffnen. Bei CloudCLI Cloud: Von jedem Gerät aus öffnen – kein VPN, keine Portweiterleitung, keine Einrichtung. Eine native App ist ebenfalls in Entwicklung.

</details>

<details>
<summary>Wirken sich Änderungen in der UI auf mein lokales Claude Code-Setup aus?</summary>

Ja, bei Self-Hosted. CloudAgent liest aus und schreibt in dieselbe `~/.claude`-Konfiguration, die Claude Code nativ verwendet. MCP-Server, die über die UI hinzugefügt werden, erscheinen sofort in Claude Code und umgekehrt.

</details>

---

## Community & Support

- **[Dokumentation](https://cloudcli.ai/docs)** — Installation, Konfiguration, Funktionen und Fehlerbehebung
- **[Discord](https://discord.gg/buxwujPNRE)** — Hilfe erhalten und mit anderen Nutzer:innen in Kontakt treten
- **[GitHub Issues](https://github.com/honte-56/CloudAgent/issues)** — Fehlerberichte und Feature-Anfragen
- **[Beitragsrichtlinien](../CONTRIBUTING.md)** — So kannst du zum Projekt beitragen

## Lizenz

GNU General Public License v3.0 – siehe [LICENSE](../LICENSE)-Datei für Details.

Dieses Projekt ist Open Source und kann unter der GPL v3-Lizenz kostenlos genutzt, modifiziert und verteilt werden.

## Danksagungen

### Erstellt mit
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** - Anthropics offizielle CLI
- **[Cursor CLI](https://docs.cursor.com/en/cli/overview)** - Cursors offizielle CLI
- **[Codex](https://developers.openai.com/codex)** - OpenAI Codex
- **[React](https://react.dev/)** - UI-Bibliothek
- **[Vite](https://vitejs.dev/)** - Schnelles Build-Tool und Dev-Server
- **[Tailwind CSS](https://tailwindcss.com/)** - Utility-first CSS-Framework
- **[CodeMirror](https://codemirror.net/)** - Erweiterter Code-Editor
- **[TaskMaster AI](https://github.com/eyaltoledano/claude-task-master)** *(Optional)* - KI-gestütztes Projektmanagement und Aufgabenplanung


### Sponsoren
- [Siteboon - KI-gestützter Website-Builder](https://siteboon.ai)
---

<div align="center">
 <strong>Mit Sorgfalt für die Claude Code-, Cursor- und Codex-Community erstellt.</strong>
</div>
