/**
 * ELSTER UStVA-Kennziffern (Stand 2025).
 * Source-of-truth: official ELSTER UStVA schema documentation.
 *
 * type = NET → Bemessungsgrundlage (net amount entered)
 * type = TAX → tax amount (input-tax / output-tax)
 */
export const KENNZIFFERN: Record<string, { type: 'NET' | 'TAX'; description: string }> = {
  '81': { type: 'NET', description: 'Steuerpflichtige Umsätze 19%' },
  '86': { type: 'NET', description: 'Steuerpflichtige Umsätze 7%' },
  '83': { type: 'NET', description: 'Steuerfreie Umsätze ohne Vorsteuerabzug' },
  '41': { type: 'NET', description: 'Innergemeinschaftliche Lieferungen' },
  '45': { type: 'NET', description: 'Übrige nicht steuerbare Umsätze' },
  '89': { type: 'NET', description: 'Steuerpflichtige EG-Lieferungen' },
  '60': { type: 'TAX', description: 'Übrige Vorsteuer' },
  '61': { type: 'TAX', description: 'Vorsteuer aus innergemeinschaftlichem Erwerb' },
  '66': { type: 'TAX', description: 'Vorsteuer aus Rechnungen (§15 UStG)' },
  '67': { type: 'TAX', description: 'Vorsteuer aus Reverse-Charge §13b UStG' },
  // Reverse-Charge §13b UStG
  '46': { type: 'NET', description: 'Sonstige Leistung EU-Unternehmer §13b Abs.1 (BMG 19%)' },
  '47': { type: 'TAX', description: 'USt auf KZ 46 (selbstberechnet)' },
  '73': { type: 'NET', description: 'Leistungen §13b Abs.2 Nr.1-5 (Drittland; BMG 19%)' },
  '74': { type: 'TAX', description: 'USt auf KZ 73 (selbstberechnet)' },
};

/**
 * Which UStVA form pages contain which Kennziffer inputs.
 * Key = ELSTER page slug (extracted from URL), value = list of Kz to fill.
 */
export const USTVA_PAGE_KZ_MAP: Record<string, string[]> = {
  LieferungenUndSonstigeLeistungen: ['81', '86'],
  LeistungenEmpfangenInnergemeinschaftlich: ['46'],
  LeistungenEmpfangenSonst: ['73'],
  AbziehbareVorsteuerbetraege: ['66', '61', '60', '67'],
};

/**
 * EÜR Kennziffer mappings. Keys are internal field names you can supply via the MCP tool,
 * labels/kzPatterns are what we try to match on the ELSTER form.
 */
export const EUR_FIELD_MAP: Array<{
  field: string;
  labels: string[];
  kzPatterns: string[];
}> = [
  { field: 'betriebseinnahmen', labels: ['Betriebseinnahmen', 'steuerpflichtige Betriebseinnahmen', 'Umsatzerlöse'], kzPatterns: ['Kz111', 'Kz100'] },
  { field: 'kfzPrivatNutzung', labels: ['Entnahmen', 'private Kfz-Nutzung', 'Privatanteile'], kzPatterns: ['Kz185', 'Kz180'] },
  { field: 'fahrzeugkosten', labels: ['Fahrzeugkosten', 'Kfz-Kosten', 'Kraftfahrzeugkosten'], kzPatterns: ['Kz175'] },
  { field: 'kfzSteuer', labels: ['Kfz-Steuer', 'Kraftfahrzeugsteuer'], kzPatterns: ['Kz166'] },
  { field: 'telekommunikation', labels: ['Telekommunikation', 'Telefon', 'Internet'], kzPatterns: ['Kz155'] },
  { field: 'versicherungen', labels: ['Versicherungen', 'Beiträge'], kzPatterns: ['Kz165'] },
  { field: 'bewirtung', labels: ['Bewirtung', 'Geschäftsessen'], kzPatterns: ['Kz157'] },
  { field: 'reisekosten', labels: ['Reisekosten'], kzPatterns: ['Kz177'] },
  { field: 'bankgebuehren', labels: ['Bankgebühren', 'Kontoführung'], kzPatterns: ['Kz169'] },
  { field: 'fremdleistungen', labels: ['Fremdleistungen', 'Subunternehmer'], kzPatterns: ['Kz135'] },
  { field: 'software', labels: ['Software', 'Lizenzen'], kzPatterns: ['Kz140'] },
  { field: 'buchfuehrung', labels: ['Buchführungskosten', 'Steuerberatung', 'Rechts- und Steuerberatung'], kzPatterns: ['Kz181'] },
  { field: 'beratung', labels: ['Rechts- und Beratungskosten', 'Beratungskosten'], kzPatterns: ['Kz181'] },
  { field: 'werbung', labels: ['Werbung', 'Werbekosten'], kzPatterns: ['Kz178'] },
  { field: 'gwg', labels: ['Geringwertige Wirtschaftsgüter', 'GWG'], kzPatterns: ['Kz131'] },
  { field: 'steuern', labels: ['Steuern, Versicherungen', 'sonstige Steuern'], kzPatterns: ['Kz167'] },
  { field: 'uebrigeBA', labels: ['übrige unbeschränkt abziehbare Betriebsausgaben', 'übrige Betriebsausgaben', 'sonstige Betriebsausgaben'], kzPatterns: ['Kz183'] },
  { field: 'afa', labels: ['Absetzung für Abnutzung auf bewegliche Wirtschaftsgüter', 'Absetzung für Abnutzung', 'AfA auf bewegliche', 'AfA'], kzPatterns: ['Kz131', 'Kz150', 'Kz136'] },
  { field: 'homeOffice', labels: ['Aufwendungen für ein häusliches Arbeitszimmer', 'häusliches Arbeitszimmer', 'Arbeitszimmer', 'Home-Office', 'Raumkosten'], kzPatterns: ['Kz176', 'Kz170'] },
  { field: 'iabAbzug', labels: ['Investitionsabzugsbetrag', 'Investitionsabzugsbeträge', '§ 7g Absatz 1', '§ 7g Abs. 1'], kzPatterns: ['Kz187', 'Kz216'] },
];

export const PORTAL_URLS = {
  start: 'https://www.elster.de/eportal/start',
  ustvaForm: 'https://www.elster.de/eportal/formulare-leistungen/alleformulare/ustvaeru',
  eurForm: 'https://www.elster.de/eportal/formulare-leistungen/alleformulare/euer',
  estForm: 'https://www.elster.de/eportal/formulare-leistungen/alleformulare/est',
  meineFormulare: 'https://www.elster.de/eportal/meineformulare',
  posteingang: 'https://www.elster.de/eportal/meinelster/meinposteingang',
};
