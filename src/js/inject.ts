/* Copyright(c) 2016-2020 Philip Mulcahy. */

'use strict';

import * as azad_order from './order';
import * as azad_table from './table';
import * as business from './business';
import * as csv from './csv';
import {dateToDateIsoString} from './date';
import * as extraction from './extraction';
import * as git_hash from './git_hash';
import * as iframeWorker from './iframe-worker';
const lzjs = require('lzjs');
import * as notice from './notice';
import * as periods from './periods';
import * as pageType from './page_type';
import * as ports from './ports';
import * as request_scheduler from './request_scheduler';
import * as settings from './settings';
import * as signin from './signin';
import * as stats from './statistics';
import * as transaction from './transaction';
import * as urls from './url';

let scheduler: request_scheduler.IRequestScheduler | null = null;
let years: number[] = [];
let stats_timeout: NodeJS.Timeout | null = null;
let quick_export_button: HTMLButtonElement | null = null;
let cached_account_name: string | null = null;

const SITE: string = urls.getSite();

const _stats = new stats.Statistics();

function getScheduler(): request_scheduler.IRequestScheduler {
  if (!scheduler) {
    resetScheduler('unknown');
  }

  return scheduler!;
}

function setStatsTimeout() {
  const sendStatsMsg = async () => {
    await _stats.publish(ports.getBackgroundPort, getScheduler().purpose());
    azad_table.updateProgressBar(_stats);
  };

  if (stats_timeout) {
    clearTimeout(stats_timeout);
  }

  stats_timeout = setTimeout(
    () => {
      setStatsTimeout();
      sendStatsMsg();
    },
    2000
  );
}

function resetScheduler(purpose: string): void {
  if (scheduler) {
    scheduler.abort();
  }

  _stats.clear();
  scheduler = request_scheduler.create(purpose, ports.getBackgroundPort, _stats);
  setStatsTimeout();
}

async function fetchAndShowOrdersByYears(
  years: number[]
): Promise<HTMLTableElement|undefined> {
  const ezp_mode: boolean = await settings.getBoolean('ezp_mode');

  if ( ! ezp_mode ) {
    if ( document.visibilityState != 'visible' ) {
      console.log(
        'fetchAndShowOrdersByYears() returning without doing anything: ' +
        'tab is not visible'
      );
      return;
    }
  }

  const purpose: string = years.join(', ');
  resetScheduler(purpose);
  const latest_year: number = await periods.getLatestYear();

  const order_promises = azad_order.getOrdersByYear(
    years,
    getScheduler(),
    latest_year,
    (_date: Date|null) => true,  // DateFilter predicate
  );

  return azad_table.display(order_promises, true, ports.getBackgroundPort);
}

async function fetchAndShowOrdersByRange(
  start_date: Date, end_date: Date,
  beautiful_table: boolean,
): Promise<HTMLTableElement|undefined> {
  console.info(`fetchAndShowOrdersByRange(${start_date}, ${end_date})`);

  if ( document.visibilityState != 'visible' ) {
    console.log(
      'fetchAndShowOrdersByRange() returning without doing anything: ' +
      'tab is not visible'
    );
    return;
  }

  const purpose: string
    = dateToDateIsoString(start_date)
    + ' -> '
    + dateToDateIsoString(end_date);

  resetScheduler(purpose);
  const latest_year: number = await periods.getLatestYear();

  const orders = azad_order.getOrdersByRange(
    start_date,
    end_date,
    getScheduler(),
    latest_year,
    function (d: Date|null): boolean {
      if (typeof(d) === 'undefined') {
        return false;
      }
      return d! >= start_date && d! <= end_date;  // DateFilter
    },
  );

  return azad_table.display(orders, beautiful_table, ports.getBackgroundPort);
}

async function fetchShowAndSendItemsByRange(
  start_date: Date,
  end_date: Date,
  destination_extension_id: string,
): Promise<void> {
  await settings.storeBoolean('ezp_mode', true);
  const original_items_setting = await settings.getBoolean('show_items_not_orders');
  await settings.storeBoolean('show_items_not_orders', true);

  const table: (HTMLTableElement|undefined) = await fetchAndShowOrdersByRange(
    start_date,
    end_date,
    false,
  );

  await settings.storeBoolean('show_items_not_orders', original_items_setting);

  if (typeof(table) != 'undefined') {
    await csv.send_csv_to_ezp_peer(table, destination_extension_id);
    await settings.storeBoolean('ezp_mode', false);
    return;
  } else {
    return undefined;
  }
}

async function registerContentScript(isIframeWorker: boolean) {
  const pgType = pageType.getPageType();
  const bg_port = await ports.getBackgroundPort();

  if (bg_port) {
    bg_port.onMessage.addListener(
      msg => {
        try {
          handleMessageFromBackground(pgType, msg);
        } catch (ex) {
          console.error(`msg handler caught ${ex} while processing ${msg}`
          );
        }
      }
    );

    if (isIframeWorker) {
      iframeWorker.requestInstructions(ports.getBackgroundPort);
    }
  } else {
    console.warn('no background port in registerContentScript()');
  }

  console.log('script registered');
}

function handleMessageFromBackground(pageType: string, msg: any): void {
  switch(pageType) {
    case 'azad_inject':
      handleMessageFromBackgroundToRootContentPage(msg);
      break;
    case 'azad_iframe_worker':
      iframeWorker.handleInstructionsResponse(msg);
      break;
    default:
      console.warn('unknown pageType:', pageType);
  }
}

function handleMessageFromBackgroundToRootContentPage(msg: any): void {
  switch(msg.action) {
    case 'dump_order_detail':
      resetScheduler('dump_order_detail');
      azad_table.dumpOrderDiagnostics(msg.order_id, getScheduler);
      break;
    case 'scrape_years':
      years = msg.years;
      if (years) {
        fetchAndShowOrdersByYears(years);
      }
      break;
    case 'scrape_range':
      {
        const start_date: Date = new Date(msg.start_date);
        const end_date: Date = new Date(msg.end_date);
        fetchAndShowOrdersByRange(
          start_date,
          end_date,
          true,
        );
      }
      break;
    case 'scrape_range_and_dump_items':
      {
        const startDate: Date = new Date(msg.start_date);
        const endDate: Date = new Date(msg.end_date);
        fetchShowAndSendItemsByRange(
          startDate,
          endDate,
          msg.sender_id,
        );
      }
      break;
    case 'start_iframe_worker':
      {
        const url = urls.normalizeUrl(msg.url, urls.getSite());
        iframeWorker.createIframe(url, msg.guid, msg.purpose);
      }
      break;
    case 'remove_iframe_worker':
      iframeWorker.removeIframeWorker(msg.guid);
      break;
    case 'transactions':
      console.log('got transactions', msg.transactions);

      (async ()=>{
        if (!pageType.isWorker()) {
          await azad_table.displayTransactions(
            msg.transactions,
            true,
            ports.getBackgroundPort,
          );
        }
      })();

      break;
    case 'clear_cache':
      getScheduler().cache().clear();
      transaction.clearCache();
      periods.clearCache();
      notice.showNotificationBar(
        'Amazon Order History Reporter Chrome' +
          ' Extension\n\n' +
          'Cache cleared',
        document
      );
      break;
    case 'force_logout':
      signin.forceLogOut('https://' + SITE);
      break;
    case 'abort':
      resetScheduler('aborted');
      break;
    default:
      console.debug('inject.ts ignoring msg.action: ' + msg.action);
  }
}

function createQuickExportButton(): void {
  console.log('createQuickExportButton called, URL:', window.location.href);

  // Check if we're on the order history page
  const url = window.location.href;
  const isOrderHistoryPage = url.includes('/order-history') || url.includes('/gp/css/order-history') || url.includes('/your-orders');

  if (!isOrderHistoryPage) {
    console.log('Not on order history page, skipping button creation');
    return;
  }

  // Find the "Your Orders" heading
  const headings = document.querySelectorAll('h1');
  console.log('Found', headings.length, 'h1 elements');
  let ordersHeading: HTMLElement | null = null;

  for (const heading of Array.from(headings)) {
    console.log('h1 text:', heading.textContent);
    if (heading.textContent?.includes('Your Orders') || heading.textContent?.includes('Your orders')) {
      ordersHeading = heading as HTMLElement;
      break;
    }
  }

  if (!ordersHeading) {
    console.log('Could not find "Your Orders" heading, will retry after DOM loads');
    // Wait for DOM to be fully loaded and try again
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => createQuickExportButton(), 1000);
      });
    } else {
      setTimeout(() => createQuickExportButton(), 1000);
    }
    return;
  }

  // Don't create duplicate buttons
  if (quick_export_button && document.contains(quick_export_button)) {
    console.log('Button already exists');
    return;
  }

  // Create the button
  quick_export_button = document.createElement('button');
  quick_export_button.textContent = 'shipment export 1 month csv';
  quick_export_button.disabled = true;
  quick_export_button.style.cssText = `
    font-size: 14px;
    color: black;
    margin-top: 10px;
    padding: 8px 16px;
    cursor: not-allowed;
    opacity: 0.6;
  `;

  quick_export_button.onclick = handleQuickExportClick;

  // Insert button after the heading
  ordersHeading.insertAdjacentElement('afterend', quick_export_button);
  console.log('Quick export button created successfully');
}

function enableQuickExportButton(): void {
  if (quick_export_button) {
    quick_export_button.disabled = false;
    quick_export_button.style.cursor = 'pointer';
    quick_export_button.style.opacity = '1';
    console.log('Quick export button enabled');
  }
}

function extractAccountNameFromPage(): string {
  // Extract account name from the navigation bar EARLY, before table rendering
  // <span id="nav-link-accountList-nav-line-1" class="nav-line-1 nav-progressive-content">Hello, Jozef</span>

  console.log('Attempting to extract account name from page...');

  // Try multiple selectors
  const selectors = [
    '#nav-link-accountList-nav-line-1',  // Most specific
    '.nav-line-1',                        // Class selector
    '[class*="nav-line-1"]',              // Contains class
  ];

  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    console.log(`Selector "${selector}" found ${elements.length} elements`);

    for (const element of Array.from(elements)) {
      const text = element.textContent?.trim();
      console.log(`Element text: "${text}"`);

      if (text && text.match(/^Hello,?\s+/i)) {
        // Extract name after "Hello, " or "Hello "
        const name = text.replace(/^Hello,?\s+/i, '').trim();
        if (name && name.length > 0) {
          console.log('Successfully extracted account name:', name);
          return name.toLowerCase().replace(/\s+/g, '_');
        }
      }
    }
  }

  console.warn('Could not extract account name from any selector, using default "user"');
  return 'user';
}

function getAccountName(): string {
  // Return cached account name (extracted during initialization)
  if (cached_account_name) {
    console.log('Using cached account name:', cached_account_name);
    return cached_account_name;
  }
  console.warn('No cached account name available, using default "user"');
  return 'user';
}

async function handleQuickExportClick(): Promise<void> {
  try {
    console.log('Starting automatic export...');

    // Set table type to shipments
    await settings.storeString('azad_table_type', 'shipments');

    // Enable shipment info
    await settings.storeBoolean('show_shipment_info', true);

    // Calculate date range for last 1 month
    const end_date = new Date();
    const start_date = new Date();
    start_date.setMonth(start_date.getMonth() - 1);

    console.log(`Auto export: scraping shipments from ${start_date} to ${end_date}`);

    // Trigger the scraping and wait for the table
    const table = await fetchAndShowOrdersByRange(start_date, end_date, false);

    if (table) {
      // Get account name for filename (from cached value)
      const accountName = getAccountName();

      // Download CSV with account name
      console.log('Auto export: downloading CSV');
      await csv.download(table, false, accountName);

      console.log('Auto export: complete');
    } else {
      throw new Error('Table generation failed');
    }
  } catch (error) {
    console.error('Auto export error:', error);
  }
}

async function autoTriggerExport(): Promise<void> {
  console.log('Auto-triggering export on page load');
  await handleQuickExportClick();
}

function isOrderHistoryPage(): boolean {
  const url = window.location.href;
  // Match order history pages including query parameters (ref_=, etc.)
  return url.includes('/gp/css/order-history') ||
         url.includes('/order-history') ||
         url.includes('/your-orders');
}

function initialiseContentScript() {
  console.log('Amazon Order History Reporter content script initialising');
  console.log(git_hash.text());

  const isWorker = pageType.isWorker();
  registerContentScript(isWorker);

  const inIframe = pageType.isIframe();

  if (!inIframe && isOrderHistoryPage()) {
    console.log('On order history page - will auto-trigger export');

    // Extract account name EARLY before any table rendering
    cached_account_name = extractAccountNameFromPage();
    console.log('Cached account name for later use:', cached_account_name);

    // Initialize periods and automatically trigger export when ready
    periods.init(ports.getBackgroundPort).then(() => {
      // Automatically trigger export after initialization
      autoTriggerExport();
    });
  } else {
    console.log('Not on order history page - skipping auto-export');
  }
}

initialiseContentScript();
