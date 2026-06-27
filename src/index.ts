#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from './config.js';
import { log } from './logger.js';
import { sessionManager } from './session-manager.js';
import { ElsterBase } from './elster/base.js';
import { ElsterUstva } from './elster/ustva.js';
import { ElsterEur } from './elster/eur.js';
import { ElsterEst } from './elster/est.js';
import { ElsterSync } from './elster/sync.js';
import { generateUstvaXml, detectReverseCharge } from './elster/xml.js';
import { KENNZIFFERN } from './elster/constants.js';

const ustva = new ElsterUstva();
const eur = new ElsterEur();
const est = new ElsterEst();
const sync = new ElsterSync();

class LoginProbe extends ElsterBase {
  async probe(): Promise<{ ok: boolean; finalUrl?: string; error?: string }> {
    try {
      const { page } = await this.initBrowser();
      try {
        await this.ensureLoggedIn(page);
        return { ok: true, finalUrl: page.url() };
      } finally {
        await this.closeBrowser();
      }
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }
}
const loginProbe = new LoginProbe();

const TOOLS: Tool[] = [
  {
    name: 'elster_login_test',
    description: 'Verifies that the configured certificate + password can log into the ELSTER portal. Returns success and final URL or an error. Use this once before submitting anything.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'elster_config_show',
    description: 'Shows the currently loaded ELSTER configuration (with secrets redacted) so you can verify env vars / config.json were picked up.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'elster_kennziffern_list',
    description: 'Returns the list of supported UStVA Kennziffern (codes 81, 86, 66 etc.) with descriptions and whether they are NET (base amount) or TAX (tax amount).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'elster_ustva_generate_xml',
    description: 'Generates an ELSTER UStVA XML snapshot for archiving. Does NOT submit (submission goes via elster_ustva_start). Useful for audit trails.',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: 'Tax year, e.g. 2026' },
        period: { type: ['integer', 'string'], description: 'Month (1-12) or quarter as "Q1".."Q4"' },
        report: {
          type: 'object',
          description: 'Map of Kennziffer → amount in EUR. Keys are the bare 2-3 digit code (e.g. "81", "66"). Net amounts for NET-type codes, tax amounts for TAX-type codes.',
          additionalProperties: { type: 'number' },
        },
      },
      required: ['year', 'period', 'report'],
      additionalProperties: false,
    },
  },
  {
    name: 'elster_ustva_detect_reverse_charge',
    description: 'Tests whether a voucher would be detected as Reverse-Charge (§13b UStG) based on the configured supplier patterns. Returns matched supplier and region (EU / NON_EU), or null.',
    inputSchema: {
      type: 'object',
      properties: {
        contactName: { type: 'string' },
        description: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'elster_ustva_start',
    description: 'Starts a UStVA submission session. Opens a browser, logs in, fills the form, runs Prüfung, then PAUSES at AWAITING_CONFIRM. You must explicitly call elster_ustva_confirm to send. Returns a sessionId — poll status via elster_session_status.',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer' },
        period: { type: ['integer', 'string'], description: 'Month (1-12) or "Q1".."Q4"' },
        report: {
          type: 'object',
          description: 'Map of Kennziffer → amount in EUR (bare digit keys, e.g. "81":12345.67).',
          additionalProperties: { type: 'number' },
        },
      },
      required: ['year', 'period', 'report'],
      additionalProperties: false,
    },
  },
  {
    name: 'elster_ustva_confirm',
    description: 'Confirms submission of a UStVA session that is in AWAITING_CONFIRM state. Triggers the final "Absenden" click. Returns the transmission ticket on success.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'elster_eur_start',
    description: 'Starts an EÜR (Anlage Einnahmen-Überschuss-Rechnung) form-prep session. Fills the form up to Prüfung, then tries to "Speichern und Verlassen" so the draft survives in ELSTER. NEVER submits.',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer' },
        data: {
          type: 'object',
          description: 'Map of field names to numeric amounts. Supported fields: betriebseinnahmen, kfzPrivatNutzung, fahrzeugkosten, kfzSteuer, telekommunikation, versicherungen, bewirtung, reisekosten, bankgebuehren, fremdleistungen, software, buchfuehrung, beratung, werbung, gwg, steuern, uebrigeBA, afa, homeOffice, iabAbzug.',
          additionalProperties: { type: 'number' },
        },
      },
      required: ['year', 'data'],
      additionalProperties: false,
    },
  },
  {
    name: 'elster_est_start',
    description: 'Starts an ESt 1 A (Einkommensteuererklärung) form-prep session. Opens the form, fills taxpayer basics from config + any extra fields you provide (by ELSTER input id/name hint), runs Prüfung, then waits 30 min for you to review in the portal. NEVER submits.',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer' },
        data: {
          type: 'object',
          description: 'Optional map of field-id hints → values. Each key is matched against ELSTER input id/name as substring. Use empty {} to only fill taxpayer basics from config.',
          additionalProperties: { type: ['number', 'string'] },
        },
      },
      required: ['year'],
      additionalProperties: false,
    },
  },
  {
    name: 'elster_session_status',
    description: 'Returns the current status, progress log, and any screenshot path for a session started via elster_ustva_start / elster_eur_start / elster_est_start.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'elster_session_list',
    description: 'Lists all currently tracked sessions (USTVA / EUR / EST / SYNC) with their status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'elster_session_cancel',
    description: 'Cancels a running session (closes the browser, marks status as CANCELLED).',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'elster_sync_history',
    description: 'Reads "Übermittelte Formulare" (transmission history) from ELSTER. Optionally downloads PDFs.',
    inputSchema: {
      type: 'object',
      properties: {
        years: { type: 'array', items: { type: 'integer' } },
        downloadPdfs: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'elster_sync_inbox',
    description: 'Reads ELSTER inbox messages ("Posteingang"). Optionally downloads each message as PDF.',
    inputSchema: {
      type: 'object',
      properties: {
        downloadPdfs: { type: 'boolean', default: false },
        maxPages: { type: 'integer', default: 20 },
      },
      additionalProperties: false,
    },
  },
];

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function redactConfig() {
  const c = loadConfig();
  return {
    ...c,
    auth: {
      pfxPath: c.auth.pfxPath,
      password: c.auth.password ? `<set, length=${c.auth.password.length}>` : '<empty>',
    },
  };
}

async function dispatch(name: string, args: any) {
  switch (name) {
    case 'elster_login_test':
      return jsonResult(await loginProbe.probe());

    case 'elster_config_show':
      return jsonResult(redactConfig());

    case 'elster_kennziffern_list':
      return jsonResult(KENNZIFFERN);

    case 'elster_ustva_generate_xml': {
      const xml = generateUstvaXml(args.report, args.year, args.period);
      return { content: [{ type: 'text' as const, text: xml }] };
    }

    case 'elster_ustva_detect_reverse_charge':
      return jsonResult(detectReverseCharge({
        contactName: args.contactName,
        description: args.description,
      }));

    case 'elster_ustva_start': {
      const id = ustva.startTransmitSession(args.report, args.year, args.period);
      return jsonResult({ sessionId: id });
    }

    case 'elster_ustva_confirm': {
      const result = await ustva.confirmTransmit(args.sessionId);
      return jsonResult(result);
    }

    case 'elster_eur_start': {
      const id = eur.startSession(args.data, args.year);
      return jsonResult({ sessionId: id });
    }

    case 'elster_est_start': {
      const id = est.startSession(args.data ?? {}, args.year);
      return jsonResult({ sessionId: id });
    }

    case 'elster_session_status': {
      const s = sessionManager.view(args.sessionId);
      if (!s) return jsonResult({ error: 'Session not found' });
      return jsonResult(s);
    }

    case 'elster_session_list':
      return jsonResult(sessionManager.list());

    case 'elster_session_cancel': {
      const s = sessionManager.get(args.sessionId);
      if (!s) return jsonResult({ error: 'Session not found' });
      switch (s.kind) {
        case 'USTVA': ustva.cancelSession(args.sessionId); break;
        case 'EUR': eur.cancelSession(args.sessionId); break;
        case 'EST': est.cancelSession(args.sessionId); break;
        default: sessionManager.delete(args.sessionId);
      }
      return jsonResult({ ok: true });
    }

    case 'elster_sync_history': {
      const items = await sync.syncHistory({
        years: args.years,
        downloadPdfs: args.downloadPdfs,
      });
      return jsonResult({ count: items.length, items });
    }

    case 'elster_sync_inbox': {
      const items = await sync.syncInbox({
        downloadPdfs: args.downloadPdfs,
        maxPages: args.maxPages,
      });
      return jsonResult({ count: items.length, items });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function main() {
  loadConfig();
  log.info('elster-mcp-server starting...');

  const server = new Server(
    { name: 'elster-mcp-server', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      return await dispatch(name, args ?? {});
    } catch (e: any) {
      log.error(`Tool ${name} failed: ${e.message}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: e.message }, null, 2) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('elster-mcp-server ready on stdio.');
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
