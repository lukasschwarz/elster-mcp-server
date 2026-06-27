# elster-mcp-server

A **Model Context Protocol (MCP) server** that lets Claude (or any MCP-capable client)
drive the German tax portal [ELSTER](https://www.elster.de) via Puppeteer.

> ⚠️ **Disclaimer**
> This project automates a real interaction with the German tax authority.
> You are solely responsible for the data you submit.
> The `elster_ustva_*` tools are the only ones that actually transmit data,
> and they always pause for an explicit confirmation step before doing so.
> EÜR and ESt tools never submit — they prepare the form and let you review
> in the ELSTER portal yourself.

## Features

| Tool | What it does | Submits? |
|------|--------------|----------|
| `elster_login_test` | Verifies your certificate + password can log in | No |
| `elster_config_show` | Shows the loaded config (secrets redacted) | No |
| `elster_kennziffern_list` | Returns the supported UStVA Kennziffern with descriptions | No |
| `elster_ustva_generate_xml` | Generates a UStVA XML snapshot (archive only) | No |
| `elster_ustva_detect_reverse_charge` | Detects §13b reverse-charge suppliers | No |
| `elster_ustva_start` | Logs in, fills, runs Prüfung, then **pauses for confirmation** | Pauses |
| `elster_ustva_confirm` | Clicks "Absenden" after you reviewed | **Yes** |
| `elster_eur_start` | Fills Anlage EÜR up to Prüfung, then "Speichern und Verlassen" | No |
| `elster_est_start` | Opens ESt 1 A, fills basics, runs Prüfung, keeps browser open 30 min | No |
| `elster_sync_history` | Reads "Übermittelte Formulare" (optionally with PDFs) | No |
| `elster_sync_inbox` | Reads ELSTER inbox (optionally with PDFs) | No |
| `elster_session_status` / `_list` / `_cancel` | Session management | No |

## Requirements

- **Node.js ≥ 18**
- An **ELSTER certificate file** (`.pfx`) — get it from `https://www.elster.de` → "Mein ELSTER" → "Mein Benutzerkonto" → "Zertifikat verlängern"
- The certificate password
- Your **Steuernummer** and **Bundesland-Code**

## Install

```bash
git clone https://github.com/YOUR_USERNAME/elster-mcp-server.git
cd elster-mcp-server
npm install
npm run build
```

Puppeteer will install a bundled Chromium on first install (~150 MB).

## Configuration

```bash
cp config.example.json config.json
$EDITOR config.json
```

All keys in `config.json` can be overridden by environment variables
(`ELSTER_PFX_PATH`, `ELSTER_PASSWORD`, `ELSTER_TAX_NUMBER`,
`ELSTER_STATE_CODE`, `ELSTER_NAME`, `ELSTER_FIRST_NAME`, `ELSTER_STREET`,
`ELSTER_HOUSE_NUMBER`, `ELSTER_ZIP`, `ELSTER_CITY`, `ELSTER_COUNTRY`,
`ELSTER_DOWNLOAD_DIR`, `ELSTER_SCREENSHOT_DIR`, `ELSTER_HEADLESS`,
`ELSTER_EST_SKIP_EUR`). Env vars win over the file.

You can also point the loader at a different config file via
`ELSTER_CONFIG_PATH=/path/to/your/config.json`.

The two-digit `stateCode` for your Finanzamt is published by ELSTER —
look up the current value in the official ELSTER documentation.

### Reverse-Charge supplier list

Add your `§13b UStG` suppliers under `ustva.reverseChargeSuppliers` in
`config.json`. Patterns are case-insensitive regexes matched against the
voucher's `contactName` or `description`. Example entry:

```json
{ "pattern": "your-supplier\\s+ireland", "region": "EU", "name": "Your Supplier Ireland" }
```

## Use with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "elster": {
      "command": "node",
      "args": ["/absolute/path/to/elster-mcp-server/dist/index.js"],
      "env": {
        "ELSTER_CONFIG_PATH": "/absolute/path/to/elster-mcp-server/config.json"
      }
    }
  }
}
```

See `examples/claude_desktop_config.json` for the template.

## Use with any MCP client

Run the server in stdio mode:

```bash
node dist/index.js
```

Then connect via your client's MCP transport.

## Typical UStVA flow

```text
1. elster_login_test                          → { ok: true }
2. elster_kennziffern_list                    → reference for valid codes
3. elster_ustva_start({                       → { sessionId: "ustva-..." }
     year: 2026,
     period: "Q1",
     report: { "81": 12000, "86": 300, "66": 1845.30 }
   })
4. elster_session_status({ sessionId })       → poll until status == AWAITING_CONFIRM
   (open the screenshot at screenshotPath to verify)
5. elster_ustva_confirm({ sessionId })        → { success: true, ticket: "..." }
```

## Typical EÜR flow

```text
1. elster_login_test
2. elster_eur_start({
     year: 2025,
     data: {
       betriebseinnahmen: 50000,
       fahrzeugkosten: 1200,
       afa: 800,
       homeOffice: 1260
     }
   })
3. elster_session_status (poll until SAVED or AWAITING_REVIEW)
4. open the ELSTER portal in your browser → "Meine Formulare" → review the draft → submit manually
```

## Security notes

- **Never commit your `.env`, `config.json`, or `.pfx`.** They are gitignored by default.
- The certificate password is read from env / config and passed to Puppeteer — make sure
  the host running this server is trusted.
- Set `ELSTER_HEADLESS=false` once to watch the first run and confirm everything is wired correctly.

## Limitations

- The ELSTER portal selectors can change. If a flow breaks, run with `ELSTER_HEADLESS=false`
  and check the screenshots written to `./screenshots/`.
- The ESt tool is intentionally a thin wrapper — German income-tax forms (Anlage G, V, N, S, KAP …)
  are dozens of different forms with thousands of fields. This server provides the framework
  (login, open, fill-by-label-or-id, Prüfen) and leaves the field choices to you.
- No XML submission path. Official programmatic submission requires the ERiC library
  (registration as a software vendor). This server uses the same Online-Formular path
  that any taxpayer uses.

## License

[MIT](LICENSE)

## Contributing

PRs welcome. The most useful additions are:

1. More robust selectors for changed ELSTER pages
2. Pre-filled Anlage G / V / N / S templates for ESt
3. A typed `report` schema validator for `elster_ustva_*`

When opening an issue, please run with `ELSTER_HEADLESS=false` and attach the
screenshot under `./screenshots/` that shows the failure.
