import { Page } from 'puppeteer';
import { ElsterBase } from './base.js';
import { log } from '../logger.js';
import { loadConfig } from '../config.js';
import { sessionManager, InternalSession } from '../session-manager.js';
import { PORTAL_URLS, USTVA_PAGE_KZ_MAP } from './constants.js';

function periodToElsterValue(period: string | number): string {
  if (typeof period === 'string' && period.startsWith('Q')) {
    return `4${period.substring(1)}`;
  }
  const m = typeof period === 'string' ? parseInt(period) : period;
  return m < 10 ? `0${m}` : `${m}`;
}

export class ElsterUstva extends ElsterBase {
  /**
   * Starts a UStVA submission flow.
   * The flow runs until the ELSTER "Prüfung" passes, then waits for explicit
   * confirmation via confirmTransmit() before clicking "Absenden".
   */
  startTransmitSession(report: Record<string, number>, year: number, period: string | number): string {
    const session = sessionManager.create('USTVA');

    const logMsg = (msg: string) => { session.progress.push(msg); log.info(msg); };

    this.runWithCheckpoint(session, report, year, period, logMsg).catch((err: Error) => {
      session.status = 'ERROR';
      session.errors = [...(session.errors || []), err.message];
      session.result = { success: false, error: err.message };
      session._resultReject?.(err);
    });

    return session.id;
  }

  confirmTransmit(sessionId: string): Promise<Record<string, unknown>> {
    const s = sessionManager.get(sessionId);
    if (!s) return Promise.reject(new Error('Session not found'));
    if (s.status !== 'AWAITING_CONFIRM') {
      return Promise.reject(new Error(`Invalid status: ${s.status}`));
    }
    return new Promise((resolve, reject) => {
      s._resultResolve = resolve;
      s._resultReject = reject;
      s._confirmResolve?.();
    });
  }

  cancelSession(sessionId: string): void {
    const s = sessionManager.get(sessionId);
    if (!s) return;
    s._confirmReject?.(new Error('Cancelled by user'));
    s.status = 'CANCELLED';
    sessionManager.delete(sessionId);
  }

  private async runWithCheckpoint(
    session: InternalSession,
    report: Record<string, number>,
    year: number,
    period: string | number,
    logMsg: (m: string) => void,
  ): Promise<void> {
    session.status = 'LOGGING_IN';
    logMsg(`Starting UStVA submission for ${year} ${period}...`);

    const { page } = await this.initBrowser();

    try {
      await this.ensureLoggedIn(page);

      session.status = 'OPENING_FORM';
      logMsg(`Opening UStVA form for ${year}...`);
      await this.openForm(page, year);
      await this.selectPeriodOnStartseite(page, period);

      session.status = 'FILLING_PAGES';
      logMsg('Walking through form pages...');
      await this.walkThroughPages(page, report);

      session.status = 'PRUEFUNG';
      logMsg('Running ELSTER "Prüfung"...');
      try {
        await this.runPruefung(page);
      } catch (err) {
        session.screenshotPath = await this.screenshot(page, `ustva_pruefung_error_${session.id}`);
        throw err;
      }
      session.screenshotPath = await this.screenshot(page, `ustva_pruefung_done_${session.id}`);

      logMsg('Prüfung passed — awaiting user confirmation to submit.');
      session.status = 'AWAITING_CONFIRM';

      await new Promise<void>((resolve, reject) => {
        session._confirmResolve = resolve;
        session._confirmReject = reject;
        setTimeout(() => reject(new Error('Confirmation timeout (15 min)')), 15 * 60 * 1000);
      });

      session.status = 'SUBMITTING';
      logMsg('Submitting...');
      const { ticket, auftrag } = await this.submitForm(page);
      session.screenshotPath = await this.screenshot(page, `ustva_submitted_${session.id}`);

      const result = { success: true, ticket, auftragsnummer: auftrag };
      session.status = 'DONE';
      session.result = result;
      session._resultResolve?.(result);
      logMsg(`Successfully submitted. Ticket: ${ticket}`);

    } catch (error: any) {
      log.error(`Session ${session.id} error: ${error.message}`);
      try {
        session.screenshotPath = await this.screenshot(page, `ustva_error_${Date.now()}`);
      } catch { /* best effort */ }
      if ((session.status as string) !== 'CANCELLED') {
        session.status = 'ERROR';
        session.errors = [...(session.errors || []), error.message];
        session.result = { success: false, error: error.message };
        session._resultReject?.(error);
      }
    } finally {
      await this.closeBrowser();
      sessionManager.scheduleCleanup(session.id);
    }
  }

  private async openForm(page: Page, year: number): Promise<void> {
    await page.goto(PORTAL_URLS.ustvaForm, { waitUntil: 'networkidle2', timeout: 60000 });

    await page.waitForSelector('#zeitraumJahr', { timeout: 15000 });
    await page.select('#zeitraumJahr', `${year}-v1`);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
      page.click('#Enter'),
    ]);

    await new Promise(r => setTimeout(r, 3000));
    await this.handleModals(page);
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    if (page.url().includes('mein-elster/startseite')) {
      log.info('Modal kicked us back to start — re-navigating...');
      await page.goto(PORTAL_URLS.ustvaForm, { waitUntil: 'networkidle2' });
      await page.waitForSelector('#zeitraumJahr', { timeout: 15000 });
      await page.select('#zeitraumJahr', `${year}-v1`);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
        page.click('#Enter'),
      ]);
      await new Promise(r => setTimeout(r, 3000));
    }

    await this.skipDataImportIfPresent(page);
  }

  private async skipDataImportIfPresent(page: Page): Promise<void> {
    const isDatenuebernahme = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      return bodyText.includes('Datenübernahme') || bodyText.includes('Ohne Datenübernahme');
    });
    if (!isDatenuebernahme) return;

    log.info('Data-import page detected → clicking "Ohne Datenübernahme fortfahren"...');
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a, input[type="button"]'));
      const btn = btns.find(b => {
        const txt = b.textContent?.trim() || (b as HTMLInputElement).value || '';
        return txt.includes('Ohne Datenübernahme') || txt.includes('ohne Datenübernahme');
      });
      if (btn) { (btn as HTMLElement).click(); return true; }
      return false;
    });
    if (clicked) {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
      await this.handleModals(page);
    }
  }

  private async selectPeriodOnStartseite(page: Page, period: string | number): Promise<void> {
    const periodValue = periodToElsterValue(period);
    log.info(`Setting period ${period} → ELSTER value ${periodValue}`);

    const zeitraumSelectors = [
      'select[id*="UmsatzsteuervoranmeldungZeitraum"]',
      'select[name*="Zeitraum"]',
      'select[id*="Zeitraum"]',
    ];

    for (let attempt = 1; attempt <= 3; attempt++) {
      let found = false;
      for (const sel of zeitraumSelectors) {
        const exists = await page.$(sel).catch(() => null);
        if (!exists) continue;
        const hasOption = await page.evaluate((s, v) => {
          const el = document.querySelector(s) as HTMLSelectElement;
          return el ? Array.from(el.options).some(o => o.value === v) : false;
        }, sel, periodValue);
        if (hasOption) {
          await page.select(sel, periodValue);
          await page.evaluate((s) => {
            const el = document.querySelector(s) as HTMLSelectElement;
            el?.dispatchEvent(new Event('change', { bubbles: true }));
          }, sel);
          found = true;
          break;
        }
      }
      if (found) break;
      if (attempt < 3) {
        await this.handleModals(page);
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 6000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 3000));
      } else {
        throw new Error(`Period dropdown for value "${periodValue}" not found after 3 attempts.`);
      }
    }

    await this.fillSteuernummer(page);
    await new Promise(r => setTimeout(r, 1500));
    await this.clickNextPage(page);
  }

  private async fillSteuernummer(page: Page): Promise<void> {
    const cfg = loadConfig();
    if (!cfg.taxpayer.taxNumber) {
      log.warn('No tax number configured (ELSTER_TAX_NUMBER).');
      return;
    }

    const landSel = 'select[id*="Steuernummer-country"], select[id*="Steuernummer"][id*="country"]';
    const landEl = await page.$(landSel).catch(() => null);
    if (landEl && cfg.taxpayer.stateCode) {
      const ok = await page.evaluate((s, code) => {
        const el = document.querySelector(s) as HTMLSelectElement;
        if (!el) return false;
        const opt = Array.from(el.options).find(o => o.value === code);
        if (!opt) return false;
        el.value = opt.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, landSel, cfg.taxpayer.stateCode);
      if (ok) {
        await new Promise(r => setTimeout(r, 1500));
        log.info(`State code set: ${cfg.taxpayer.stateCode}`);
      } else {
        log.warn(`State code "${cfg.taxpayer.stateCode}" not found in dropdown.`);
      }
    }

    const stNrSel = 'input[id*="Steuernummer-tax-number-tax-office"], input[id*="Steuernummer"][id*="tax-number"]';
    const stNrHandle = await page.$(stNrSel).catch(() => null);
    if (stNrHandle) {
      await stNrHandle.click({ clickCount: 3 });
      await new Promise(r => setTimeout(r, 100));
      await page.keyboard.type(cfg.taxpayer.taxNumber, { delay: 30 });
      await page.keyboard.press('Tab');
      await new Promise(r => setTimeout(r, 2000));
      log.info(`Tax number entered: ${cfg.taxpayer.taxNumber}`);
    } else {
      log.warn('Tax number input not found.');
    }
  }

  private async walkThroughPages(page: Page, report: Record<string, number>): Promise<void> {
    const MAX_PAGES = 15;
    let pageCount = 0;
    let lastUrl = '';
    let sameUrlCount = 0;

    while (pageCount < MAX_PAGES) {
      pageCount++;
      await new Promise(r => setTimeout(r, 2000));

      const currentUrl = page.url();
      log.info(`[Page ${pageCount}] ${currentUrl}`);

      if (currentUrl === lastUrl) {
        sameUrlCount++;
        if (sameUrlCount >= 3) {
          log.warn(`Stuck on "${currentUrl.split('/').pop()}" — aborting.`);
          break;
        }
      } else {
        sameUrlCount = 0;
      }
      lastUrl = currentUrl;

      await this.handleModals(page);

      const pageName = this.extractPageName(currentUrl);
      if (pageName) await this.fillPageFields(page, pageName, report);

      const hasNextBtn = await this.hasNextPageButton(page);
      if (!hasNextBtn) {
        log.info('No more "Next page" button — all input pages done.');
        break;
      }

      await this.clickNextPage(page);
      await new Promise(r => setTimeout(r, 500));
      await this.handleModals(page);
    }
  }

  private extractPageName(url: string): string | null {
    const parts = url.split('/');
    const last = parts[parts.length - 1].split('?')[0].split('#')[0];
    return last || null;
  }

  private async hasNextPageButton(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.some(b => {
        const txt = b.textContent?.trim() || '';
        return txt.includes('Nächste Seite') && (b as HTMLElement).offsetParent !== null;
      });
    });
  }

  private async fillPageFields(page: Page, pageName: string, report: Record<string, number>): Promise<void> {
    if (pageName === 'AngabenUnternehmen') {
      await this.fillAngabenUnternehmen(page);
      return;
    }
    const kzFields = USTVA_PAGE_KZ_MAP[pageName];
    if (!kzFields || kzFields.length === 0) return;

    log.info(`Filling fields on "${pageName}": ${kzFields.join(', ')}`);
    for (const kz of kzFields) {
      const value = report[kz] ?? report[`Kz${kz}`] ?? 0;
      if (value === 0) continue;
      const filled = await this.fillKzInput(page, kz, value);
      if (!filled) log.warn(`Kz ${kz} not filled (field not found).`);
    }
  }

  private async fillAngabenUnternehmen(page: Page): Promise<void> {
    const cfg = loadConfig();
    const fieldMap: Array<{ idPatterns: string[]; labelTexts: string[]; value: string }> = [
      { idPatterns: ['UnternehmerName', 'Nachname'], labelTexts: ['Name', 'Nachname'], value: cfg.taxpayer.name },
      { idPatterns: ['Vorname'], labelTexts: ['Vorname'], value: cfg.taxpayer.firstName },
      { idPatterns: ['UnternehmerStr', 'Strasse', 'AdresseStrasse'], labelTexts: ['Straße', 'Strasse'], value: cfg.taxpayer.street },
      { idPatterns: ['UnternehmerHausnummer', 'Hausnummer'], labelTexts: ['Hausnummer'], value: cfg.taxpayer.houseNumber },
      { idPatterns: ['UnternehmerPLZ', 'PLZ', 'Postleitzahl'], labelTexts: ['Postleitzahl', 'PLZ'], value: cfg.taxpayer.zip },
      { idPatterns: ['UnternehmerOrt', 'Ort', 'Wohnort'], labelTexts: ['Ort', 'Gemeinde'], value: cfg.taxpayer.city },
      { idPatterns: ['UnternehmerLand', 'Land'], labelTexts: ['Land'], value: cfg.taxpayer.country },
    ];

    for (const { idPatterns, labelTexts, value } of fieldMap) {
      if (!value) continue;
      let filled = false;
      for (const pattern of idPatterns) {
        const sel = `input[id*="${pattern}"]:not([type="hidden"]):not([readonly]):not([disabled])`;
        const handle = await page.$(sel).catch(() => null);
        if (handle) {
          const visible = await handle.evaluate((el) => (el as HTMLElement).offsetParent !== null).catch(() => false);
          if (visible) {
            await handle.click({ clickCount: 3 });
            await new Promise(r => setTimeout(r, 100));
            await page.keyboard.type(value, { delay: 30 });
            await page.keyboard.press('Tab');
            await new Promise(r => setTimeout(r, 500));
            filled = true;
            break;
          }
        }
      }
      if (!filled) {
        for (const labelText of labelTexts) {
          filled = await this.fillFieldByLabel(page, labelText, value);
          if (filled) break;
        }
      }
      if (!filled) log.warn(`AngabenUnternehmen: field "${idPatterns[0]}" not found.`);
    }
  }

  private async fillFieldByLabel(page: Page, labelText: string, value: string): Promise<boolean> {
    const handle = await page.evaluateHandle((text) => {
      const allEls = Array.from(document.querySelectorAll('label, th, span, div, td'));
      for (const el of allEls) {
        const txt = (el.textContent || '').trim();
        if (txt === text || txt.startsWith(text + ' ') || txt.startsWith(text + ':')) {
          const forAttr = (el as HTMLLabelElement).htmlFor;
          if (forAttr) {
            const inp = document.getElementById(forAttr) as HTMLInputElement;
            if (inp && !inp.readOnly && !inp.disabled && (inp as any).offsetParent !== null) return inp;
          }
          const parent = el.closest('tr, .form-group, .field, .row, div');
          if (parent) {
            const inp = parent.querySelector<HTMLInputElement>('input:not([type="hidden"]):not([readonly]):not([disabled])');
            if (inp && (inp as any).offsetParent !== null) return inp;
          }
        }
      }
      return null;
    }, labelText);
    const el = handle.asElement() as any;
    if (!el) return false;
    await el.click({ clickCount: 3 });
    await new Promise(r => setTimeout(r, 100));
    await page.keyboard.type(value, { delay: 30 });
    await page.keyboard.press('Tab');
    await new Promise(r => setTimeout(r, 500));
    return true;
  }

  private async fillKzInput(page: Page, kz: string, value: number): Promise<boolean> {
    const kzPadded = kz.length < 3 ? kz.padStart(3, '0') : kz;

    // Safety: input-tax Kennziffern (66/61/60/67) must never be negative.
    const isInputTaxKz = ['66', '61', '60', '67'].includes(kz) || ['66', '61', '60', '67'].includes(kzPadded);
    if (isInputTaxKz && value < 0) {
      throw new Error(
        `Input-tax Kz${kz} has negative value ${value.toFixed(2)} — likely a sign bug in your aggregation. Aborted.`,
      );
    }
    const safeValue = isInputTaxKz ? Math.abs(value) : value;

    const selectors = [
      `input[id*="Kz${kz}"][type!="hidden"]:not([id*="EOL"])`,
      `input[id*="Kz${kzPadded}"][type!="hidden"]:not([id*="EOL"])`,
      `input[name*="Kz${kz}"][type!="hidden"]`,
    ];

    let handle: any = null;
    for (const sel of selectors) {
      handle = await page.$(sel).catch(() => null);
      if (handle) {
        const visible = await handle.evaluate((el: HTMLElement) => el.offsetParent !== null).catch(() => false);
        if (visible) break;
        handle = null;
      }
    }

    if (!handle) {
      handle = await page.evaluateHandle((kzVal: string) => {
        const allEls = Array.from(document.querySelectorAll('*'));
        for (const el of allEls) {
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') continue;
          const directText = Array.from(el.childNodes)
            .filter((n: any) => n.nodeType === 3)
            .map((n: any) => n.textContent?.trim() || '')
            .join('').trim();
          if (directText === kzVal) {
            const xpath = `preceding::input[not(@type='hidden')][1]`;
            const result = document.evaluate(xpath, el, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            const inp = result.singleNodeValue as HTMLInputElement | null;
            if (inp && (inp as any).offsetParent !== null) return inp;
            const parent = el.closest('div, tr, li, section') as Element | null;
            if (parent) {
              const inp2 = parent.querySelector('input:not([type="hidden"])') as HTMLInputElement | null;
              if (inp2 && (inp2 as any).offsetParent !== null) return inp2;
            }
          }
        }
        const xpathA = `//span[normalize-space(text())='${kzVal}']/preceding::input[not(@type='hidden')][1]`;
        const resultA = document.evaluate(xpathA, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const nodeA = resultA.singleNodeValue as HTMLInputElement | null;
        if (nodeA && (nodeA as any).offsetParent !== null) return nodeA;
        return null;
      }, kz).then((h: any) => h?.asElement?.() ?? null).catch(() => null);
    }

    if (!handle) return false;

    const placeholder = await handle.evaluate((el: HTMLInputElement) => el.placeholder || '');
    const formatted = placeholder.toLowerCase().includes('cent')
      ? safeValue.toFixed(2).replace('.', ',')
      : Math.round(safeValue).toString();

    await handle.click({ clickCount: 3 });
    await new Promise(r => setTimeout(r, 200));
    await page.keyboard.type(formatted, { delay: 30 });
    await page.keyboard.press('Tab');
    await new Promise(r => setTimeout(r, 1500));

    log.info(`Kz ${kz} = ${formatted}`);
    return true;
  }

  private async clickNextPage(page: Page): Promise<void> {
    let btnHandle: any = await page.evaluateHandle(() => {
      const result = document.evaluate(
        `//button[contains(normalize-space(.),'Nächste Seite') and not(@disabled)]`,
        document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null,
      );
      const node = result.singleNodeValue as HTMLButtonElement | null;
      return (node && (node as any).offsetParent !== null) ? node : null;
    }).then((h: any) => h?.asElement?.() ?? null).catch(() => null);

    if (!btnHandle) {
      const buttons = await page.$$('button');
      for (const btn of buttons) {
        const txt = await btn.evaluate((el: Element) => (el as HTMLElement).textContent?.trim() || '');
        const visible = await btn.evaluate((el: Element) => (el as HTMLElement).offsetParent !== null);
        if (txt.includes('Nächste Seite') && visible) { btnHandle = btn; break; }
      }
    }

    if (!btnHandle) return;
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
      btnHandle.click(),
    ]);
  }

  private async runPruefung(page: Page): Promise<void> {
    const clicked = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('a, button, li'));
      const el = els.find(e => {
        const txt = e.textContent?.trim() || '';
        return txt.includes('Prüfen') && !txt.includes('Absenden') && (e as HTMLElement).offsetParent !== null;
      });
      if (el) { (el as HTMLElement).click(); return true; }
      return false;
    });
    if (!clicked) throw new Error('"Prüfen" tab not found.');

    await new Promise(r => setTimeout(r, 5000));

    const pruefResult = await page.evaluate(() => {
      const body = document.body.innerText.toLowerCase();
      const hasErrors = body.includes('fehler vorhanden') || body.includes('sind noch fehler') || body.includes('fehlerliste');
      const noErrors = body.includes('keine fehler') || body.includes('keine pflichtfehler');
      const errEls = document.querySelectorAll('.alert-danger, .feedback--error, .validation-error, [class*="error"]');
      const errTexts = Array.from(errEls).map(e => e.textContent?.trim()).filter(Boolean);
      return { hasErrors, noErrors, errTexts };
    });

    if (pruefResult.hasErrors && !pruefResult.noErrors) {
      const msg = pruefResult.errTexts.length > 0
        ? pruefResult.errTexts.join('; ')
        : 'ELSTER Prüfung found errors. See screenshot.';
      throw new Error(msg);
    }

    const clickedWeiter = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => {
        const txt = b.textContent?.trim() || '';
        return txt === 'Weiter' && (b as HTMLElement).offsetParent !== null;
      });
      if (btn) { (btn as HTMLButtonElement).click(); return true; }
      return false;
    });
    if (!clickedWeiter) log.warn('"Weiter" button not found after Prüfung.');
    await new Promise(r => setTimeout(r, 3000));
  }

  private async submitForm(page: Page): Promise<{ ticket: string; auftrag: string }> {
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => {
        const txt = b.textContent?.trim() || '';
        return txt === 'Absenden' && (b as HTMLElement).offsetParent !== null;
      });
      if (btn) { (btn as HTMLButtonElement).click(); return true; }
      return false;
    });
    if (!clicked) throw new Error('"Absenden" button not found.');

    try {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
    } catch {
      await new Promise(r => setTimeout(r, 10000));
    }

    return page.evaluate(() => {
      const body = document.body.innerText;
      const cells = Array.from(document.querySelectorAll('td, dt, dd, span, div, p'));
      let ticket = '';
      let auftrag = '';
      for (let i = 0; i < cells.length; i++) {
        const txt = cells[i].textContent?.trim() || '';
        if (txt.toLowerCase().includes('transferticket') && cells[i + 1]) {
          ticket = cells[i + 1].textContent?.trim() || '';
        }
        if ((txt.toLowerCase().includes('auftragsnummer') || txt.toLowerCase().includes('telenummer')) && cells[i + 1]) {
          auftrag = cells[i + 1].textContent?.trim() || '';
        }
      }
      if (!ticket) {
        const m = body.match(/Transferticket[:\s]+([A-Z0-9-]+)/i);
        if (m) ticket = m[1];
      }
      return { ticket, auftrag };
    });
  }
}
