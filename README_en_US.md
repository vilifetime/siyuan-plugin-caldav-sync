English | [简体中文](README.md)

# CalDAV Calendar & Tasks

Manage calendars and todos on your CalDAV server (Radicale / Baikal / Synology / iCloud with app password) directly inside SiYuan: **two-way sync**, **year / month / week / day views**, **task view**, **full editing**, and one-click insertion of today's schedule into your daily note.

## Features

- **Two-way sync**: local edits are pushed back (merged upload), server changes pulled periodically (default every 15 min) and on demand
- **Incremental sync**: uses `sync-collection` + sync-token when available, falls back to `PROPFIND` + `calendar-multiget`
- **Five views**: year view (12-month grid with busy dates marked, click a month/day to jump), month view, week view (time grid + current-time line), day view, and task view (dropdown-filter style, inspired by the SiYuan plugin "任务笔记管理": today / tomorrow / next 7 days / this week / future / overdue / last 7 days / all undone / no date / done today / done yesterday / done, with counts and quick add)
- **Event sorting**: the "Sort" dropdown on the top-right supports sorting by event start / end time, affecting month-view cells and the week-view all-day area
- **Full editing**: title, calendar, all-day, start/end, recurrence (day/week/month/year + interval + weekdays + end conditions), reminders, location, tags, notes, priority, status, completion
- **Multiple calendars**: color-coded (category color first, calendar color as fallback), individually toggleable, default calendar for new items
- **Recurring events**: RRULE expansion with EXDATE support
- **Daily note integration**: insert today's schedule & todos into the daily note (only items actually due today; todos are placed by due date; the note is opened afterwards and repeated clicks update the previously inserted section instead of appending again)
- **Two request channels**: SiYuan kernel proxy (no CORS) by default, automatic fallback to direct browser requests

## Install

1. Install from SiYuan marketplace ("Settings → Marketplace → Downloaded"), or unzip `package.zip` into `workspace/data/plugins/siyuan-plugin-caldav-sync/`
2. Restart SiYuan, click the "Calendar & Tasks" dock icon on the left. Under the title is a row of 5 buttons:
   - **New event / todo** (dropdown): opens the editor dialog
   - **Sort** (dropdown): by event start / end time
   - **Calendar view**: opens the calendar tab in the main window (year / month / week / day switchable at the top)
   - **Task view**: opens the task view tab
   - **Refresh**: sync now
3. In the calendar tab, use the "Year / Month / Week / Day" segmented control to switch views

## Configuration

"Settings → CalDAV Sync" or the gear icon on the panel:

| Option | Description |
| --- | --- |
| Server URL | e.g. `http://192.168.1.10:5232/`, `https://dav.example.com/` |
| Username / Password | Basic auth; use an app-specific password for iCloud / Nextcloud |
| Calendar path | Optional. Leave empty for auto-discovery |
| Request channel | Auto (kernel proxy first) / kernel proxy / direct |
| Auto-sync interval | Minutes, 0 disables |
| Conflict policy | Server-first / local-first on 412 conflicts |
| Sync range | Past N days / future N days |

Click "Test Connection", then "Discover Calendars", pick the calendars you want and save.

### Radicale example

Radicale uses `htpasswd` auth by default; plain Basic works out of the box:

```ini
[auth]
type = htpasswd
htpasswd_filename = /etc/radicale/users
htpasswd_encryption = plain

[server]
hosts = 0.0.0.0:5232
```

If direct requests fail with CORS errors, set the channel to "SiYuan kernel proxy".

## Data & conflicts

- Data is stored in plugin private storage `workspace/data/storage/siyuan-plugin-caldav-sync/caldav-sync-dock.json`, never written into notes
- Server ICS raw text is preserved on edit so unmanaged properties (e.g. ATTENDEE) survive round-trips
- Uploads carry `If-Match` etags; a 412 response is resolved by the configured conflict policy (server-first: local change discarded; local-first: forced overwrite)
- Deletions are propagated to the server (local tombstone first, removed after sync)

## Commands (bind hotkeys in "Settings → Hotkeys")

- `Sync CalDAV Now`
- `New Todo`
- `Open Calendar & Tasks`
- `Insert Today's Schedule into Daily Note`

## Reminders

- Only items **with a reminder time** (a VALARM entry, set via the editor's reminder dropdown) will notify. Items without one never fire — if nothing happens, check *Settings → Reminders* for "items with a reminder time".
- When a reminder is due, three channels fire together: an **in-app reminder card** (visible whenever the SiYuan window is on screen), a desktop notification (best effort), and a SiYuan notification-center message (so it is still there when you come back to the window). The card also offers "Open" and "Snooze 5 min".
- Verify the channel any time via **Settings → Reminders → Test reminder**.
- Why desktop notifications may not show up: Electron grants notification permission silently — there is deliberately no permission dialog — and on Windows a portable SiYuan has no Start Menu shortcut, so the OS discards toasts without raising an error. In that case the in-app card is the channel you can rely on.
- A reminder missed by more than 5 minutes is skipped (no backfill for old items); within 5 minutes it is fired once, so starting SiYuan shortly after a reminder still notifies.

## Notes

- Passwords are stored as AES-GCM ciphertext; the master key lives alongside the plugin data, so **SiYuan cloud sync carries it to your other devices** and you never re-enter the password. Note this is encryption, not a vault — anyone who can read the plugin data can decrypt it. Use self-hosted / LAN servers or restricted accounts
- Times are written as UTC in ICS; floating times are interpreted in the local timezone
- Mobile (Android / iOS) supported: SiYuan has no tab bar on mobile and `openTab` is a no-op there, so the panel opens as a full-screen layer instead of a tab. Long-press an item to bring up the edit/delete menu (right-click on desktop)
  - On phones the calendar cells show the title only (time + title do not fit); narrowing the desktop window still keeps the time
  - Mobile WebViews block cleartext-HTTP direct requests (`Failed to fetch`); when a direct request fails at the network level the plugin falls back to the SiYuan kernel proxy automatically — unrelated to your password
  - Mobile entry points: "Calendar & Tasks" in the top-right "Plugins" menu, or the "Calendar view / Task view" buttons in the plugin side drawer
  - On iPhone long-press does not trigger the system menu, but the long-press gesture itself works (explicitly implemented, not relying on `contextmenu`)

## Development

```bash
npm i
cp .env.example .env   # point VITE_SIYUAN_WORKSPACE_PATH at your SiYuan workspace
npm run build          # produces package.zip
npm test               # core unit tests + loader/UI smoke (jsdom)
npm run test:e2e       # real CalDAV end-to-end against Radicale
```

Test coverage:

- `test/core.test.mjs`: ICS parsing/serialization, RRULE expansion, EXDATE, store merge strategy
- `test/loader.test.mjs`: loads dist/index.js against a simulated SiYuan loader → dock buttons / main-window tab / commands → year/month/week/day/task views and switching → sorting / editor dialog
- `test/mobile.test.mjs`: simulated mobile frontend → top-bar entry / full-screen dialog panel / no openTab / view switching / long-press menu / hidden item times / narrow-screen styles
- `test/toggle.test.mjs`: todo check-circle must keep toggling on repeated clicks
- `test/e2e.test.mjs`: real Radicale round-trip (connect / discover / MKCALENDAR / upload / fetch / edit / 412 / sync-token / todos / delete)

## License

AGPL-3.0 license
