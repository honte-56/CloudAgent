<div align="center">
 <img src="../public/logo.svg" alt="CloudAgent" width="64" height="64">
 <h1>CloudAgent</h1>
 <p>Десктопный и мобильный UI для <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>, <a href="https://docs.cursor.com/en/cli/overview">Cursor CLI</a>, <a href="https://developers.openai.com/codex">Codex</a>.<br>Используйте локально или удалённо, чтобы просматривать активные проекты и сессии отовсюду.</p>
</div>

CloudAgent is derived from [CloudCLI / Claude Code UI](https://github.com/siteboon/claudecodeui). References to CloudCLI Cloud, third-party plugins, and upstream documentation still refer to those original services.

<div align="right"><i><a href="../README.md">English</a> · <b>Русский</b> · <a href="./README.de.md">Deutsch</a> · <a href="./README.ko.md">한국어</a> · <a href="./README.zh-CN.md">简体中文</a> · <a href="./README.zh-TW.md">繁體中文</a> · <a href="./README.ja.md">日本語</a> · <a href="./README.tr.md">Türkçe</a> · <a href="./README.id.md">Bahasa Indonesia</a></i></div>

---

## Скриншоты

<div align="center">

<table>
<tr>
<td align="center">
<h3>Версия для десктопа</h3>
<img src="../public/screenshots/desktop-main.png" alt="Desktop Interface" width="400">
<br>
<em>Основной интерфейс с обзором проекта и чатом</em>
</td>
<td align="center">
<h3>Мобильный режим</h3>
<img src="../public/screenshots/mobile-chat.png" alt="Mobile Interface" width="250">
<br>
<em>Адаптивный мобильный дизайн с сенсорной навигацией</em>
</td>
</tr>
<tr>
<td align="center" colspan="2">
<h3>Выбор CLI</h3>
<img src="../public/screenshots/cli-selection.png" alt="CLI Selection" width="400">
<br>
<em>Выбирайте между Claude Code, Cursor CLI и Codex</em>
</td>
</tr>
</table>



</div>

## Возможности

- **Адаптивный дизайн** - одинаково хорошо работает на десктопе, планшете и телефоне, поэтому можно пользоваться агентами и с мобильных устройств
- **Интерактивный чат-интерфейс** - встроенный чат для бесшовного общения с агентами
- **Интегрированный shell-терминал** - прямой доступ к CLI агентов через встроенную оболочку
- **Проводник файлов** - интерактивное дерево файлов с подсветкой синтаксиса и редактированием в реальном времени
- **Git Explorer** - просмотр, stage и commit изменений. Также можно переключать ветки
- **Управление сессиями** - возобновляйте диалоги, управляйте несколькими сессиями и отслеживайте историю
- **Система плагинов** - расширяйте CloudAgent кастомными плагинами — добавляйте новые вкладки, бэкенд-сервисы и интеграции. [Создать свой →](https://github.com/cloudcli-ai/cloudcli-plugin-starter)
- **Интеграция с TaskMaster AI** *(опционально)* - продвинутое управление проектами с планированием задач на базе AI, разбором PRD и автоматизацией workflow
- **Совместимость с моделями** - работает с семействами моделей Claude и GPT (полный список поддерживаемых моделей доступен через `GET /api/providers/:provider/models`)


## Быстрый старт

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

## Безопасность и конфигурация инструментов

**🔒 Важное примечание**: все инструменты Claude Code **по умолчанию отключены**. Это предотвращает автоматический запуск потенциально опасных операций.

### Включение инструментов

Чтобы использовать всю функциональность Claude Code, вам нужно вручную включить инструменты:

1. **Откройте настройки инструментов** - нажмите на иконку шестерёнки в боковой панели
2. **Включайте выборочно** - активируйте только те инструменты, которые вам нужны
3. **Примените настройки** - ваши предпочтения сохраняются локально

<div align="center">

![Tools Settings Modal](../public/screenshots/tools-modal.png)
*Интерфейс настройки инструментов — включайте только то, что вам нужно*

</div>

**Рекомендуемый подход**: начните с базовых инструментов и добавляйте остальные по мере необходимости. Эти настройки всегда можно изменить позже.

---

## Плагины

У CloudAgent есть система плагинов, которая позволяет добавлять кастомные вкладки со своим frontend UI и (опционально) Node.js бэкендом. Устанавливайте плагины напрямую из git-репозиториев в **Settings > Plugins** или создавайте свои.

### Доступные плагины

| Плагин | Описание |
|---|---|
| **[Project Stats](https://github.com/cloudcli-ai/cloudcli-plugin-starter)** | Показывает количество файлов, строки кода, разбивку по типам файлов, самые большие файлы и недавно изменённые файлы для текущего проекта |
| **[Web Terminal](https://github.com/cloudcli-ai/cloudcli-plugin-terminal)** | Полноценный терминал xterm.js с поддержкой нескольких вкладок |
| **[CloudCLI Scheduler](https://github.com/grostim/cloudcli-cron)** | Создаёт запланированные промпты для рабочей области и запускает их через локальную CLI, например Codex или Claude Code |
| **[PRISM CloudCLI](https://github.com/jakeefr/cloudcli-plugin-prism)** | Аналитика сессий Claude Code внутри CloudAgent, включая видимость расхода токенов |
| **[Sessions](https://github.com/strykereye2/cloudcli-plugin-session-manager)** | Просмотр, управление и завершение активных сессий Claude Code |
| **[Token Cost Calculator](https://github.com/NightmareAway/cloudcli-plugin-token-cost-calculator)** | Расчёт стоимости API по ценам моделей и использованию токенов, с поддержкой пресетов цен |
| **[Task Queue](https://github.com/TadMSTR/cloudcli-plugin-task-queue)** | Дашборд очереди задач для просмотра, фильтрации и запуска агентских задач |
| **[GitHub Issues Board](https://github.com/szmidtpiotr/claude-github-issue)** | Kanban-доска для GitHub Issues с двусторонней синхронизацией TaskMaster и автоустановкой CLI-навыка /github-task |
| **[ccx](https://github.com/AaronWong1999/cloudcli-plugin-ccx)** | Показывает расход лимитов Claude и Codex и передаёт открытую сессию другому агенту вместе с историей диалога (macOS, нужен ccx) |

### Создать свой

**[Plugin Starter Template →](https://github.com/cloudcli-ai/cloudcli-plugin-starter)** — сделайте форк этого репозитория, чтобы создать свой плагин. В шаблоне есть рабочий пример с рендерингом на фронтенде, live-обновлением контекста и RPC-коммуникацией с бэкенд-сервером.

**[Plugin Documentation →](https://cloudcli.ai/docs/plugin-overview)** — полный гайд по plugin API, формату манифеста, модели безопасности и другому.

---
## FAQ

<details>
<summary>Чем это отличается от Claude Code Remote Control?</summary>

Claude Code Remote Control позволяет отправлять сообщения в сессию, которая уже запущена в вашем локальном терминале. Ваша машина должна оставаться включённой, терминал — открытым, а сессии завершаются примерно через 10 минут без сетевого соединения.

CloudAgent и CloudCLI Cloud расширяют Claude Code, а не работают рядом с ним — ваши MCP-серверы, разрешения, настройки и сессии остаются теми же самыми, что и в нативном Claude Code. Ничего не дублируется и не управляется отдельно.

Вот что это означает на практике:

- **Все ваши сессии, а не одна** — CloudAgent автоматически находит каждую сессию из папки `~/.claude`. Remote Control предоставляет только одну активную сессию, чтобы сделать её доступной в мобильном приложении Claude.
- **Ваши настройки — это ваши настройки** — MCP-серверы, права инструментов и конфигурация проекта, изменённые в CloudAgent, записываются напрямую в конфиг Claude Code и вступают в силу сразу же, и наоборот.
- **Работает с большим числом агентов** — Claude Code, Cursor CLI и Codex, а не только Claude Code.
- **Полноценный UI, а не просто окно чата** — проводник файлов, Git-интеграция, управление MCP и shell-терминал — всё встроено.
- **CloudCLI Cloud работает в облаке** — закройте ноутбук, и агент продолжит работать. Не нужно следить за терминалом и держать машину постоянно активной.

</details>

<details>
<summary>Нужно ли отдельно платить за AI-подписку?</summary>

Да. CloudAgent предоставляет среду, а не сам AI. Вы приносите свою подписку Claude, Cursor или Codex. CloudCLI Cloud начинается от €7/месяц за хостируемую среду поверх этого.

</details>

<details>
<summary>Можно ли пользоваться CloudAgent с телефона?</summary>

Да. Для self-hosted запустите сервер на своей машине и откройте `[yourip]:port` в любом браузере в вашей сети. Для CloudCLI Cloud откройте сервис с любого устройства — без VPN, проброса портов и дополнительной настройки. Нативное приложение тоже в разработке.

</details>

<details>
<summary>Повлияют ли изменения, сделанные в UI, на мой локальный Claude Code?</summary>

Да, в self-hosted режиме. CloudAgent читает и записывает тот же конфиг `~/.claude`, который Claude Code использует нативно. MCP-серверы, добавленные через UI, сразу появляются в Claude Code, и наоборот.

</details>

---

## Сообщество и поддержка

- **[Документация](https://cloudcli.ai/docs)** — установка, настройка, возможности и устранение неполадок
- **[Discord](https://discord.gg/buxwujPNRE)** — помощь и общение с другими пользователями
- **[GitHub Issues](https://github.com/honte-56/CloudAgent/issues)** — сообщения об ошибках и запросы новых функций
- **[Руководство для контрибьюторов](../CONTRIBUTING.md)** — как участвовать в развитии проекта

## Лицензия

GNU General Public License v3.0 - подробности в файле [LICENSE](../LICENSE).

Этот проект open source и бесплатен для использования, модификации и распространения в рамках лицензии GPL v3.

## Благодарности

### Используется
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** - официальный CLI от Anthropic
- **[Cursor CLI](https://docs.cursor.com/en/cli/overview)** - официальный CLI от Cursor
- **[Codex](https://developers.openai.com/codex)** - OpenAI Codex
- **[React](https://react.dev/)** - библиотека пользовательских интерфейсов
- **[Vite](https://vitejs.dev/)** - быстрый инструмент сборки и dev-сервер
- **[Tailwind CSS](https://tailwindcss.com/)** - utility-first CSS framework
- **[CodeMirror](https://codemirror.net/)** - продвинутый редактор кода
- **[TaskMaster AI](https://github.com/eyaltoledano/claude-task-master)** *(опционально)* - AI-управление проектами и планирование задач


### Спонсоры
- [Siteboon - AI powered website builder](https://siteboon.ai)
---

<div align="center">
 <strong>Сделано с заботой для сообщества Claude Code, Cursor и Codex.</strong>
</div>
