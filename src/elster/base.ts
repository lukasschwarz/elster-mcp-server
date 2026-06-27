import puppeteer, { Browser, Page } from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../config.js';
import { log } from '../logger.js';
import { PORTAL_URLS } from './constants.js';

export class ElsterBase {
  protected browser: Browser | null = null;
  protected page: Page | null = null;

  protected async initBrowser(): Promise<{ browser: Browser; page: Page }> {
    const cfg = loadConfig();
    this.browser = await puppeteer.launch({
      headless: cfg.runtime.headless,
      args: cfg.runtime.browserArgs,
    });
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1280, height: 1024 });

    const downloadDir = path.resolve(cfg.runtime.downloadDir);
    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

    const client = await this.page.createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
    });

    const browserClient = await this.browser.target().createCDPSession();
    await browserClient.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: downloadDir,
      eventsEnabled: true,
    });

    return { browser: this.browser, page: this.page };
  }

  protected async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }

  protected screenshotPath(name: string): string {
    const cfg = loadConfig();
    const dir = path.resolve(cfg.runtime.screenshotDir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${name}.png`);
  }

  protected async screenshot(page: Page, name: string): Promise<string> {
    const file = this.screenshotPath(name);
    try { await page.screenshot({ path: file, fullPage: true }); } catch { /* best effort */ }
    return file;
  }

  protected async ensureLoggedIn(page: Page): Promise<boolean> {
    const cfg = loadConfig();
    if (!cfg.auth.pfxPath) throw new Error('ELSTER_PFX_PATH not configured.');
    if (!fs.existsSync(cfg.auth.pfxPath)) {
      throw new Error(`ELSTER certificate not found at: ${cfg.auth.pfxPath}`);
    }

    log.info('Navigating to ELSTER start page...');
    await page.goto(PORTAL_URLS.start, { waitUntil: 'networkidle2', timeout: 60000 });

    const currentUrl = page.url();
    if (currentUrl.includes('mein-elster/startseite') || currentUrl.includes('eportal/mein-elster')) {
      log.info('Already logged in.');
      return true;
    }

    const loginButton = await page.$('a[href*="login"], button.btn-login');
    if (loginButton) {
      log.info('Clicking login button...');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        loginButton.click(),
      ]);
    }

    log.info('Selecting certificate login method...');
    const certMethodSelector = 'a[href*="login/zertifikat"], #login-zertifikat';
    try {
      await page.waitForSelector(certMethodSelector, { timeout: 10000 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click(certMethodSelector),
      ]);
    } catch {
      log.info('Certificate login page already loaded or selector differs.');
    }

    log.info('Waiting for certificate upload field...');
    const uploadSelector = 'input[type="file"], #loginZertifikat-dateiauswahl';
    await page.waitForSelector(uploadSelector, { timeout: 20000 });

    const uploadInput = await page.$(uploadSelector);
    if (!uploadInput) throw new Error('Certificate upload field not found.');
    // @ts-expect-error - puppeteer's typing on $() returns generic ElementHandle
    await uploadInput.uploadFile(cfg.auth.pfxPath);
    log.info('Certificate selected.');

    await new Promise(r => setTimeout(r, 1000));
    const passSelector = 'input[id*="passwort"], input[type="password"]';
    await page.waitForSelector(passSelector, { timeout: 10000 });
    await page.type(passSelector, cfg.auth.password, { delay: 50 });

    log.info('Submitting login...');
    const submitSelector = 'button[type="submit"], #loginZertifikat-login, button.btn-primary';
    let loginBtn = await page.$(submitSelector);
    if (!loginBtn) {
      const handle = await page.evaluateHandle(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        return btns.find(b => b.textContent?.includes('Login')) || null;
      });
      loginBtn = handle.asElement() as any;
    }
    if (!loginBtn) throw new Error('Login button not found.');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
      loginBtn.click(),
    ]);

    const finalUrl = page.url();
    if (finalUrl.includes('mein-elster/startseite') || finalUrl.includes('eportal/mein-elster')) {
      log.info('Login successful.');
      return true;
    }

    const errorText = await page.evaluate(() => {
      const err = document.querySelector('.alert-danger, .error-message, .feedback--error');
      return err ? err.textContent?.trim() : null;
    });
    if (errorText) throw new Error(`ELSTER login error: ${errorText}`);
    return false;
  }

  /**
   * Generic modal handler — declines session-resume prompts and similar dialogs.
   */
  protected async handleModals(page: Page): Promise<void> {
    try {
      const result = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a, .btn'));
        const body = document.body.innerText;

        if (body.includes('Eingabefehler gefunden') || body.includes('In einem Feld ist ein Eingabefehler')) {
          const btn = btns.find(b => b.textContent?.trim().includes('Zum Fehler'));
          if (btn) { (btn as HTMLElement).click(); return 'input-error modal closed'; }
        }

        if (body.includes('Wiederaufnahme') || body.includes('wiederaufnehmen') ||
            body.includes('gespeicherten Stand') || body.includes('vorherigen Eingaben') ||
            body.includes('automatische Wiederherstellung') || body.includes('letzten Stand der Bearbeitung')) {
          const nein = btns.find(b => b.textContent?.trim() === 'Nein');
          if (nein) { (nein as HTMLElement).click(); return 'resume rejected'; }
        }

        if (body.includes('Möchten Sie das Formular verlassen') || body.includes('Temporäre Aufgaben')) {
          const cancel = btns.find(b => {
            const t = (b.textContent || '').toLowerCase();
            return t.includes('nein') || t.includes('abbrechen') || t.includes('bleiben');
          });
          if (cancel) { (cancel as HTMLElement).click(); return 'leave-form modal cancelled'; }
        }

        return null;
      });
      if (result) log.info(`Modal handled: ${result}`);
    } catch { /* swallow */ }
  }
}
