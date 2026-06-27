import { Page } from 'puppeteer';
import { ElsterBase } from './base.js';
import { log } from '../logger.js';
import { loadConfig } from '../config.js';
import { sessionManager, InternalSession } from '../session-manager.js';
import { PORTAL_URLS, EUR_FIELD_MAP } from './constants.js';

/**
 * Anlage EÜR (Einnahmen-Überschuss-Rechnung) — Puppeteer automation.
 * Fills the form up to "Prüfen" + tries "Speichern und Verlassen". NEVER submits.
 */
export class ElsterEur extends ElsterBase {

  startSession(data: Record<string, number>, year: number): string {
    const session = sessionManager.create('EUR');
    const logMsg = (msg: string) => { session.progress.push(msg); log.info(`[EUR] ${msg}`); };

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
    data: Record<string, number>,
    year: number,
    logMsg: (m: string) => void,
  ): Promise<void> {
    session.status = 'LOGGING_IN';
    logMsg(`Preparing EÜR form for ${year}...`);

    const { page } = await this.initBrowser();

    try {
      await this.ensureLoggedIn(page);
      await new Promise(r => setTimeout(r, 3000));
      await this.dismissPostLoginModals(page);

      session.status = 'OPENING_FORM';
      await this.openEurForm(page, year);

      session.status = 'FILLING_PAGES';
      await this.walkAndFillPages(page, data, logMsg);

      session.status = 'PRUEFUNG';
      logMsg('Running ELSTER "Prüfung"...');
      await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('a, button'));
        const el = els.find(e => {
          const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
          return t.includes('Prüfen') && (e as HTMLElement).offsetParent !== null;
        });
        if (el) (el as HTMLElement).click();
      }).catch(() => {});
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 8000));
      session.screenshotPath = await this.screenshot(page, `eur_pruefung_${session.id}`);

      const pruefResult = await page.evaluate(() => {
        const body = document.body.innerText.toLowerCase();
        return { hasErrors: body.includes('fehler'), noErrors: body.includes('keine fehler') };
      }).catch(() => ({ hasErrors: false, noErrors: false }));

      if (pruefResult.noErrors) logMsg('Prüfung passed — no errors.');
      else if (pruefResult.hasErrors) {
        logMsg('Prüfung: errors found (see screenshot).');
        session.errors = ['Prüfung produced errors — see screenshot'];
      }

      session.status = 'SAVING';
      const saveResult = await this.saveAndExit(page, logMsg);
      if (saveResult.saved) {
        session.status = 'SAVED';
        logMsg(`Saved successfully (${saveResult.method}).`);
      } else {
        session.status = 'AWAITING_REVIEW';
        logMsg(`Save failed (${saveResult.method}). Browser stays open 10 min for manual save.`);
        await new Promise<void>((resolve) => {
          session._doneResolve = resolve;
          setTimeout(resolve, 10 * 60 * 1000);
        });
      }
      session.status = 'DONE';

    } catch (error: any) {
      log.error(`[EUR] Session ${session.id} error: ${error.message}`);
      try { session.screenshotPath = await this.screenshot(page, `eur_error_${Date.now()}`); } catch {}
      if (!['CANCELLED', 'ERROR'].includes(session.status)) {
        session.status = 'ERROR';
        session.errors = [...(session.errors || []), error.message];
      }
    } finally {
      await this.closeBrowser();
      sessionManager.scheduleCleanup(session.id);
    }
  }

  private async openEurForm(page: Page, year: number): Promise<void> {
    await page.goto(PORTAL_URLS.eurForm, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));
    await this.dismissPostLoginModals(page);

    try {
      await page.waitForSelector('#zeitraumJahr', { timeout: 15000 });
      await page.select('#zeitraumJahr', `${year}-v1`);
    } catch {
      log.warn('[EUR] Year selector not found.');
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

    await page.evaluate(() => {
      const body = document.body.innerText;
      if (body.includes('Wiederaufnahme') || body.includes('gespeicherten Stand')) {
        const btns = Array.from(document.querySelectorAll('button, a'));
        const nein = btns.find(b => (b.textContent || '').trim() === 'Nein');
        if (nein) (nein as HTMLElement).click();
      }
    }).catch(() => {});
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a, input[type="button"]'));
      const btn = btns.find(b => {
        const txt = b.textContent?.trim() || (b as HTMLInputElement).value || '';
        return txt.includes('Ohne Datenübernahme');
      });
      if (btn) (btn as HTMLElement).click();
    }).catch(() => {});
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
    await this.handleModals(page);
  }

  private async walkAndFillPages(page: Page, data: Record<string, number>, logMsg: (m: string) => void): Promise<void> {
    const MAX_PAGES = 40;
    let pageCount = 0;
    let lastUrl = '';
    let sameUrlCount = 0;
    const filledPages = new Set<string>();

    while (pageCount < MAX_PAGES) {
      pageCount++;
      await new Promise(r => setTimeout(r, 2000));

      const currentUrl = page.url();
      const pageName = this.extractPageName(currentUrl);
      if (currentUrl === lastUrl) {
        sameUrlCount++;
        if (sameUrlCount >= 3) { logMsg(`Stuck on "${pageName}" — abort.`); break; }
      } else { sameUrlCount = 0; }
      lastUrl = currentUrl;

      if (pageName && !filledPages.has(pageName)) {
        filledPages.add(pageName);
        logMsg(`[Page ${pageCount}] ${pageName}`);
        await this.fillEurPage(page, pageName, data, logMsg);
      }

      await this.handleModals(page);
      const hasNext = await this.hasNextPageButton(page);
      if (!hasNext) { logMsg('No more "Next page" — done.'); break; }
      await this.clickNextPage(page);
      await new Promise(r => setTimeout(r, 500));
      await this.handleModals(page);
    }
  }

  private async fillEurPage(page: Page, pageName: string, data: Record<string, number>, logMsg: (m: string) => void): Promise<void> {
    const n = pageName.toLowerCase();

    if (n.includes('startseite') || n.includes('steuernummer') || n.includes('angaben')) {
      await this.fillSteuernummer(page, logMsg);
      return;
    }

    if (n.includes('einnahm') || n.includes('ausgab') || n.includes('betriebs') ||
        n.includes('abschreib') || n.includes('afa') || n.includes('iab') ||
        n.includes('raumkost') || n.includes('arbeitszimmer') || n.includes('homeoffice') ||
        n.includes('gewinn') || n.includes('ergebnis') || n.includes('wareneink')) {
      await this.fillKzFields(page, data, logMsg);
    }
  }

  private async fillKzFields(page: Page, data: Record<string, number>, logMsg: (m: string) => void): Promise<void> {
    for (const { field, labels, kzPatterns } of EUR_FIELD_MAP) {
      const value = data[field];
      if (!value || value === 0) continue;
      const strValue = Math.round(value).toString();

      let done = false;
      for (const kz of kzPatterns) {
        const found = await page.evaluate((pattern) => {
          const inputs = Array.from(document.querySelectorAll('input, textarea'));
          for (const inp of inputs) {
            const id = inp.id || (inp as HTMLInputElement).name || '';
            if (id.includes(pattern) && !(inp as HTMLInputElement).disabled &&
                !(inp as HTMLInputElement).readOnly && (inp as HTMLInputElement).type !== 'hidden') {
              (inp as HTMLInputElement).focus();
              (inp as HTMLInputElement).select();
              return true;
            }
          }
          return false;
        }, kz).catch(() => false);

        if (found) {
          await page.keyboard.down('Control');
          await page.keyboard.press('a');
          await page.keyboard.up('Control');
          await page.keyboard.press('Delete');
          await page.keyboard.type(strValue, { delay: 30 });
          await page.keyboard.press('Tab');
          await new Promise(r => setTimeout(r, 500));
          logMsg(`  ✓ ${field} = ${strValue} (${kz})`);
          done = true;
          break;
        }
      }

      if (!done) {
        for (const label of labels) {
          const found = await page.evaluate((text) => {
            const allEls = Array.from(document.querySelectorAll('label, th, span, div, td'));
            for (const el of allEls) {
              const txt = (el.textContent || '').trim();
              if (txt.includes(text)) {
                const forAttr = (el as HTMLLabelElement).htmlFor;
                if (forAttr) {
                  const inp = document.getElementById(forAttr) as HTMLInputElement;
                  if (inp && !inp.readOnly && !inp.disabled) { inp.focus(); inp.select(); return true; }
                }
                const parent = el.closest('tr, .form-group, div');
                if (parent) {
                  const inp = parent.querySelector<HTMLInputElement>('input:not([type="hidden"]):not([readonly]):not([disabled])');
                  if (inp) { inp.focus(); inp.select(); return true; }
                }
              }
            }
            return false;
          }, label).catch(() => false);
          if (found) {
            await page.keyboard.down('Control');
            await page.keyboard.press('a');
            await page.keyboard.up('Control');
            await page.keyboard.press('Delete');
            await page.keyboard.type(strValue, { delay: 30 });
            await page.keyboard.press('Tab');
            await new Promise(r => setTimeout(r, 500));
            logMsg(`  ✓ ${field} = ${strValue} (label: ${label})`);
            break;
          }
        }
      }
    }
  }

  private async fillSteuernummer(page: Page, logMsg: (m: string) => void): Promise<void> {
    const cfg = loadConfig();
    if (!cfg.taxpayer.taxNumber) return;

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
      if (ok) { await new Promise(r => setTimeout(r, 1500)); logMsg(`  state code = ${cfg.taxpayer.stateCode}`); }
    }

    const stNrSel = 'input[id*="Steuernummer-tax-number"], input[id*="Steuernummer"][id*="tax-number"]';
    const stNrHandle = await page.$(stNrSel).catch(() => null);
    if (stNrHandle) {
      await stNrHandle.click({ clickCount: 3 });
      await page.keyboard.type(cfg.taxpayer.taxNumber, { delay: 30 });
      await page.keyboard.press('Tab');
      await new Promise(r => setTimeout(r, 2000));
      logMsg(`  Steuernummer = ${cfg.taxpayer.taxNumber}`);
    }
  }

  private extractPageName(url: string): string | null {
    const parts = url.split('/');
    const last = parts[parts.length - 1].split('?')[0].split('#')[0];
    return last || null;
  }

  private async hasNextPageButton(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a'));
      return btns.some(b => {
        const txt = b.textContent?.trim() || '';
        return (txt.includes('Nächste Seite') || txt === 'Weiter') && (b as HTMLElement).offsetParent !== null;
      });
    });
  }

  private async clickNextPage(page: Page): Promise<void> {
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a'));
      const btn = btns.find(b => {
        const txt = (b.textContent || '').trim();
        return (txt.includes('Nächste Seite') || txt === 'Weiter') && (b as HTMLElement).offsetParent !== null;
      });
      if (btn) (btn as HTMLElement).click();
    });
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
  }

  private async saveAndExit(page: Page, logMsg: (m: string) => void): Promise<{ saved: boolean; method: string }> {
    const triggerClicked = await page.evaluate(() => {
      const lower = (s: string) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const els = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
      const exact = els.find(e => {
        if ((e as HTMLElement).offsetParent === null) return false;
        const t = lower(e.textContent || (e as HTMLInputElement).value || '');
        return t === 'speichern und formular verlassen' || t.includes('speichern und formular verlassen');
      });
      if (exact) { (exact as HTMLElement).click(); return 'Speichern und Formular verlassen'; }
      return null;
    }).catch(() => null);

    if (!triggerClicked) return { saved: false, method: 'trigger button not found' };
    logMsg(`  click "${triggerClicked}" (opens modal).`);
    await new Promise(r => setTimeout(r, 3000));

    const modalConfirmed = await page.evaluate(() => {
      const lower = (s: string) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const els = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
      const visible = els.filter(e => (e as HTMLElement).offsetParent !== null);
      let btn = visible.find(e => lower(e.textContent || (e as HTMLInputElement).value || '') === 'speichern und verlassen');
      if (btn) { (btn as HTMLElement).click(); return 'Speichern und Verlassen'; }
      btn = visible.find(e => {
        const t = lower(e.textContent || (e as HTMLInputElement).value || '');
        return t.includes('speichern und verlassen') && !t.includes('ohne');
      });
      if (btn) { (btn as HTMLElement).click(); return 'Speichern und Verlassen (fuzzy)'; }
      return null;
    }).catch(() => null);

    if (!modalConfirmed) return { saved: false, method: 'modal button "Speichern und Verlassen" not found' };
    logMsg(`  modal: "${modalConfirmed}".`);

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 4000));

    const success = await page.evaluate(() => {
      const body = (document.body?.innerText || '').toLowerCase();
      return body.includes('meine formulare') || body.includes('mein elster') ||
             body.includes('entwurf gespeichert') || body.includes('erfolgreich gespeichert');
    }).catch(() => false);

    return { saved: !!success, method: modalConfirmed };
  }

  private async dismissPostLoginModals(page: Page): Promise<void> {
    for (let i = 0; i < 3; i++) {
      try {
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, a'));
          const b = btns.find(x => {
            const t = (x.textContent || '').trim().toLowerCase();
            return t.includes('bestätigen') || t === 'nein' || t === 'ok' || t === 'weiter';
          });
          if (b) (b as HTMLElement).click();
        });
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1000));
      } catch {}
    }
  }
}
