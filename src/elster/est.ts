import { Page } from 'puppeteer';
import { ElsterBase } from './base.js';
import { log } from '../logger.js';
import { loadConfig } from '../config.js';
import { sessionManager, InternalSession } from '../session-manager.js';
import { PORTAL_URLS } from './constants.js';

/**
 * ESt 1 A (Einkommensteuererklärung) — opens the form, fills basic taxpayer
 * fields where possible, runs Prüfung, then waits for manual review.
 *
 * NEVER submits. Always stops at "Prüfen". The user reviews and submits in the
 * portal manually.
 *
 * NOTE: The ELSTER ESt form has dozens of "Anlagen" (G, V, N, S, KAP, …) each
 * with its own field semantics. This implementation provides the framework
 * (login, open, walk pages, fill labeled fields by name, prüfen) but expects
 * the caller to pass a flat key→value map matching what they want to fill.
 * Field matching is best-effort by label/id pattern.
 */
export class ElsterEst extends ElsterBase {

  startSession(data: Record<string, number | string>, year: number): string {
    const session = sessionManager.create('EST');
    const logMsg = (msg: string) => { session.progress.push(msg); log.info(`[ESt] ${msg}`); };

    this.run(session, data, year, logMsg).catch((err: Error) => {
      session.status = 'ERROR';
      session.errors = [...(session.errors || []), err.message];
    });

    return session.id;
  }

  cancelSession(sessionId: string): void {
    const s = sessionManager.get(sessionId);
    if (!s) return;
    s.status = 'CANCELLED';
    sessionManager.delete(sessionId);
  }

  private async run(
    session: InternalSession,
    data: Record<string, number | string>,
    year: number,
    logMsg: (m: string) => void,
  ): Promise<void> {
    session.status = 'LOGGING_IN';
    logMsg(`Preparing ESt form for ${year}...`);

    const { page } = await this.initBrowser();

    try {
      await this.ensureLoggedIn(page);
      await new Promise(r => setTimeout(r, 3000));
      await this.handleModals(page);

      session.status = 'OPENING_FORM';
      await this.openEstForm(page, year);

      session.status = 'FILLING_PAGES';
      await this.walkAndFill(page, data, logMsg);

      session.status = 'PRUEFUNG';
      logMsg('Running ELSTER "Prüfung"...');
      await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('a, button, li'));
        const el = els.find(e => {
          const txt = e.textContent?.trim() || '';
          return txt.includes('Prüfen') && !txt.includes('Absenden') && (e as HTMLElement).offsetParent !== null;
        });
        if (el) (el as HTMLElement).click();
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 8000));
      session.screenshotPath = await this.screenshot(page, `est_pruefung_${session.id}`);

      session.status = 'AWAITING_REVIEW';
      logMsg('Prüfung done. Browser stays open 30 min for manual review. NOT submitted.');

      await new Promise<void>((resolve) => {
        session._doneResolve = resolve;
        setTimeout(resolve, 30 * 60 * 1000);
      });
      session.status = 'DONE';

    } catch (error: any) {
      log.error(`[ESt] Session ${session.id} error: ${error.message}`);
      try { session.screenshotPath = await this.screenshot(page, `est_error_${Date.now()}`); } catch {}
      if (!['CANCELLED', 'ERROR'].includes(session.status)) {
        session.status = 'ERROR';
        session.errors = [...(session.errors || []), error.message];
      }
    } finally {
      await this.closeBrowser();
      sessionManager.scheduleCleanup(session.id);
    }
  }

  private async openEstForm(page: Page, year: number): Promise<void> {
    await page.goto(PORTAL_URLS.estForm, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));

    try {
      await page.waitForSelector('#zeitraumJahr', { timeout: 15000 });
      await page.select('#zeitraumJahr', `${year}-v1`);
    } catch {
      const ok = await page.evaluate((y) => {
        const selects = Array.from(document.querySelectorAll('select'));
        for (const sel of selects) {
          const opt = Array.from(sel.options).find(o => o.value.includes(String(y)));
          if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; }
        }
        return false;
      }, year);
      if (!ok) log.warn('[ESt] Year selector not found.');
    }

    const startBtn = await page.$('#Enter');
    if (startBtn) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
        startBtn.click(),
      ]);
    }
    await new Promise(r => setTimeout(r, 3000));
    await this.handleModals(page);
  }

  private async walkAndFill(page: Page, data: Record<string, number | string>, logMsg: (m: string) => void): Promise<void> {
    const cfg = loadConfig();
    const merged: Record<string, number | string> = {
      _name: cfg.taxpayer.name,
      _firstName: cfg.taxpayer.firstName,
      _street: cfg.taxpayer.street,
      _houseNumber: cfg.taxpayer.houseNumber,
      _zip: cfg.taxpayer.zip,
      _city: cfg.taxpayer.city,
      _country: cfg.taxpayer.country,
      ...data,
    };

    const MAX_PAGES = 50;
    let count = 0;
    let lastUrl = '';
    let sameUrlCount = 0;

    while (count < MAX_PAGES) {
      count++;
      await new Promise(r => setTimeout(r, 2000));

      const url = page.url();
      const pageName = this.extractPageName(url);
      if (url === lastUrl) {
        sameUrlCount++;
        if (sameUrlCount >= 3) { logMsg(`Stuck on "${pageName}" — abort.`); break; }
      } else sameUrlCount = 0;
      lastUrl = url;

      logMsg(`[Page ${count}] ${pageName}`);
      await this.fillByGenericRules(page, merged, logMsg);
      await this.handleModals(page);

      const hasNext = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a'));
        return btns.some(b => {
          const txt = b.textContent?.trim() || '';
          return (txt.includes('Nächste Seite') || txt === 'Weiter') && (b as HTMLElement).offsetParent !== null;
        });
      });
      if (!hasNext) { logMsg('No more "Next page" — done.'); break; }

      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a'));
        const btn = btns.find(b => {
          const txt = (b.textContent || '').trim();
          return (txt.includes('Nächste Seite') || txt === 'Weiter') && (b as HTMLElement).offsetParent !== null;
        });
        if (btn) (btn as HTMLElement).click();
      });
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 500));
      await this.handleModals(page);
    }
  }

  private async fillByGenericRules(page: Page, data: Record<string, number | string>, logMsg: (m: string) => void): Promise<void> {
    const labelMap: Array<{ key: string; labels: string[] }> = [
      { key: '_name', labels: ['Name', 'Nachname'] },
      { key: '_firstName', labels: ['Vorname'] },
      { key: '_street', labels: ['Straße', 'Strasse'] },
      { key: '_houseNumber', labels: ['Hausnummer'] },
      { key: '_zip', labels: ['Postleitzahl', 'PLZ'] },
      { key: '_city', labels: ['Ort', 'Wohnort'] },
    ];

    for (const { key, labels } of labelMap) {
      const value = data[key];
      if (!value) continue;
      for (const label of labels) {
        const ok = await this.fillFieldByLabel(page, label, String(value));
        if (ok) { logMsg(`  ${key} → "${value}" (label: ${label})`); break; }
      }
    }

    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('_')) continue;
      if (value == null || value === '') continue;
      const ok = await this.fillById(page, key, String(value));
      if (ok) logMsg(`  ${key} = ${value} (id-match)`);
    }
  }

  private async fillById(page: Page, idHint: string, value: string): Promise<boolean> {
    const found = await page.evaluate((hint, val) => {
      const inputs = Array.from(document.querySelectorAll('input, textarea')) as HTMLInputElement[];
      for (const inp of inputs) {
        if (inp.disabled || inp.readOnly || inp.type === 'hidden') continue;
        if (!inp.id && !inp.name) continue;
        if ((inp.id || inp.name).includes(hint)) {
          inp.focus();
          inp.value = val;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    }, idHint, value).catch(() => false);
    return found;
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

  private extractPageName(url: string): string | null {
    const parts = url.split('/');
    const last = parts[parts.length - 1].split('?')[0].split('#')[0];
    return last || null;
  }
}
