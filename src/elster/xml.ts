import { loadConfig } from '../config.js';

/**
 * Generates an ELSTER UStVA XML for the given report.
 *
 * NOTE: This XML is a *snapshot* useful for archiving. The official ELSTER
 * submission path used by this server is via the Online-Formular flow
 * (Puppeteer). For programmatic XML submission you would need the ERiC
 * library (proprietary, requires registration as a software vendor).
 */
export function generateUstvaXml(
  report: Record<string, number>,
  year: number,
  period: number | string,
): string {
  const cfg = loadConfig();
  const schemaVersion = year >= 2025 ? '2025' : '2023';
  const outerVersion = '11';

  let zeitraum: string;
  if (typeof period === 'string' && period.startsWith('Q')) {
    zeitraum = `4${period.substring(1)}`; // Q1→41, Q2→42, Q3→43, Q4→44
  } else {
    const m = typeof period === 'string' ? parseInt(period) : period;
    zeitraum = m < 10 ? `0${m}` : `${m}`;
  }

  const taxNumber = (cfg.taxpayer.taxNumber || '').replace(/\D/g, '');
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  let xml = '<?xml version="1.0" encoding="ISO-8859-15" standalone="no"?>';
  xml += `\n<Elster xmlns="http://www.elster.de/elsterxml/schema/v${outerVersion}" version="${outerVersion}">`;
  xml += `\n  <TransferHeader version="${outerVersion}">`;
  xml += '\n    <Verfahren>ElsterAnmeldung</Verfahren>';
  xml += '\n    <DatenArt>UStVA</DatenArt>';
  xml += '\n    <Vorgang>send-Auth</Vorgang>';
  xml += '\n    <HerstellerID>74999</HerstellerID>';
  xml += '\n  </TransferHeader>';
  xml += '\n  <DatenTeil>';
  xml += '\n    <Nutzdatenblock>';
  xml += `\n      <NutzdatenHeader version="${outerVersion}">`;
  xml += '\n        <NutzdatenArt>UStVA</NutzdatenArt>';
  xml += '\n        <Empfaenger id="F">DE</Empfaenger>';
  xml += '\n      </NutzdatenHeader>';
  xml += '\n      <Nutzdaten>';
  xml += `\n        <Anmeldungssteuern xmlns="http://finkonsens.de/elster/elsteranmeldung/ustva/v${schemaVersion}" version="${schemaVersion}">`;
  xml += `\n          <Erstellungsdatum>${today}</Erstellungsdatum>`;
  xml += '\n          <Steuerfall>';
  xml += '\n            <Umsatzsteuervoranmeldung>';
  xml += `\n              <Jahr>${year}</Jahr>`;
  xml += `\n              <Zeitraum>${zeitraum}</Zeitraum>`;
  if (taxNumber) xml += `\n              <Steuernummer>${taxNumber}</Steuernummer>`;

  const sortedCodes = Object.keys(report).sort((a, b) => parseInt(a) - parseInt(b));
  for (const code of sortedCodes) {
    const value = report[code];
    if (value === 0) continue;
    xml += `\n              <Kz${code}>${value.toFixed(2)}</Kz${code}>`;
  }

  xml += '\n            </Umsatzsteuervoranmeldung>';
  xml += '\n          </Steuerfall>';
  xml += '\n        </Anmeldungssteuern>';
  xml += '\n      </Nutzdaten>';
  xml += '\n    </Nutzdatenblock>';
  xml += '\n  </DatenTeil>';
  xml += '\n</Elster>';
  return xml;
}

export interface ReverseChargeMatch {
  region: 'EU' | 'NON_EU';
  supplier: string;
}

/**
 * Reverse-Charge detection (§13b UStG). Reads supplier patterns from config.
 */
export function detectReverseCharge(v: {
  contactName?: string | null;
  description?: string | null;
}): ReverseChargeMatch | null {
  const cfg = loadConfig();
  const name = (v.contactName || '').trim();
  const desc = (v.description || '').toLowerCase();

  for (const s of cfg.ustva.reverseChargeSuppliers) {
    try {
      const re = new RegExp(s.pattern, 'i');
      if (re.test(name) || re.test(desc)) {
        return { region: s.region, supplier: s.name };
      }
    } catch { /* skip invalid regex */ }
  }

  const explicitRc = /reverse[\s-]?charge|steuerschuldnerschaft\s+des\s+leistungsempfaengers|steuerschuldnerschaft\s+des\s+leistungsempf(ä|ae)ngers|tax\s+to\s+be\s+paid\s+on\s+reverse\s+charge/i
    .test(v.description || '');
  if (explicitRc) {
    return {
      region: /usa|america|inc\.|llc|pbc/i.test(name) ? 'NON_EU' : 'EU',
      supplier: name || 'Unknown',
    };
  }
  return null;
}
