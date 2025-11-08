/* Copyright(c) 2023 Philip Mulcahy. */

import * as item from './item';
import * as extraction from './extraction';
import * as order_header from './order_header';
import * as req from './request';
import * as request_scheduler from './request_scheduler';
import * as url from './url';
import * as util from './util';

export interface ITransaction {
  payment_amount: string;
  info_string: string;
}

interface ITrackingPageItem {
  name: string;
  quantity: number;
}

interface ITrackingPageData {
  tracking_id: string;
  one_time_passcode: string;
  items_from_tracking: ITrackingPageItem[];
}

export enum Delivered {
  YES = 1,
  NO = 2,
  UNKNOWN = 3,
}

export interface IShipment {
  shipment_id: string,
  items: item.IItem[],
  delivered: Delivered;
  status: string;
  tracking_link: string;
  tracking_id: string;
  one_time_passcode: string;
  items_from_tracking: ITrackingPageItem[];
  transaction: ITransaction|null,
  refund: string;
}

export async function get_shipments(
  order_detail_doc: HTMLDocument,
  _url: string,  // for debugging
  order_header: order_header.IOrderHeader,
  context: string,
  scheduler: request_scheduler.IRequestScheduler,
  site: string,
): Promise<IShipment[]> {
  const doc_elem = order_detail_doc.documentElement;
  const transactions = get_transactions(doc_elem);

  function strategy_a(): Node[] {
    const candidates = extraction.findMultipleNodeValues(
        '//div[contains(@class, "a-box shipment")]',
        doc_elem);

    // We want elem to have 'shipment' as one of its classes
    // not just have one of its classes _contain_ 'shipment' in its name.
    // There may be a way to do this in xpath, but it wouldn't be very
    // readable, and I am also a bit short on sleep.
    return candidates.filter(
      elem => {
        const cs: string = util.defaulted(
          (elem as HTMLElement)!.getAttribute('class'), '');
          const classes: string[] = cs.split(' ');
          return classes.includes('shipment');
      }
    );
  }

  function strategy_b(): Node[] {
    return extraction.findMultipleNodeValues(
      '//div[div[@data-component="shipmentsLeftGrid"]/div[div[@data-component="shipmentStatus"]]]',
      doc_elem);
  }

  const elems = extraction.firstMatchingStrategy([strategy_a, strategy_b], []);

  const shipment_promises = elems.map(e => shipment_from_elem(
    e as HTMLElement,
    order_header,
    context,
    scheduler,
    site,
  ));

  const shipments = await util.get_settled_and_discard_rejects(
    shipment_promises
  );

  if (shipments.length == transactions.length) {
    for (let i=0; i!=shipments.length; ++i) {
      shipments[i].transaction = transactions[i];
    }
  }

  return shipments;
}

function data_from_tracking_page(evt: req.Event): ITrackingPageData {
  const html_text = evt.target.responseText;
  const doc = util.parseStringToDOM(html_text);
  const body = doc.body;

  // Extract tracking ID
  const id_xpath = "//div[contains(@class, 'pt-delivery-card-trackingId')]";
  const tracking_id: string|null = extraction.getField2(
    [id_xpath],
    body,
    '',
    'tracking_id_from_tracking_page'
  );

  // Extract one-time passcode from alert content
  // HTML: <div class="a-alert-content">Your one-time password is 805331...</div>
  const otp_xpath = "//div[contains(@class, 'a-alert-content')]";
  const alert_content: string|null = extraction.getField2(
    [otp_xpath],
    body,
    '',
    'otp_from_tracking_page'
  );

  let one_time_passcode = '';
  if (alert_content) {
    // Extract digits after "one-time password is"
    const match = alert_content.match(/one-time password is (\d+)/i);
    if (match && match[1]) {
      one_time_passcode = match[1];
    }
  }

  // Extract items from carousel
  // HTML: <div class="pt-floating-map-card"><ol class="a-carousel"><li class="a-carousel-card">...
  // Restrict to pt-floating-map-card to exclude suggested items and other carousels
  const items_from_tracking: ITrackingPageItem[] = [];
  try {
    const carousel_items = extraction.findMultipleNodeValues(
      "//div[@class='pt-floating-map-card']//li[contains(@class, 'a-carousel-card')]",
      body
    );

    console.log(`Found ${carousel_items.length} carousel items on tracking page`);

    carousel_items.forEach((item_elem: Node, idx: number) => {
      try {
        // Extract ASIN from href="/gp/product/B0D3J71RM7?..."
        let asin = '';
        try {
          const link = extraction.findSingleNodeValue(
            ".//a[contains(@href, '/gp/product/')]",
            item_elem as HTMLElement,
            'tracking_page_item_link'
          );
          const href = (link as HTMLAnchorElement)?.href || '';
          // Extract ASIN: /gp/product/B0D3J71RM7 -> B0D3J71RM7
          const asin_match = href.match(/\/gp\/product\/([A-Z0-9]+)/);
          if (asin_match && asin_match[1]) {
            asin = asin_match[1];
            console.log(`Item ${idx}: Extracted ASIN: ${asin}`);
          }
        } catch (e) {
          console.log(`Item ${idx}: Failed to extract ASIN from link`);
        }

        // Extract quantity from <span class="images-quantity-label"> (default to 1 if not found)
        let quantity = 1;
        try {
          const qty_span = extraction.findSingleNodeValue(
            ".//span[contains(@class, 'images-quantity-label')]",
            item_elem as HTMLElement,
            'tracking_page_item_quantity'
          );
          if (qty_span) {
            const qty_text = qty_span.textContent?.trim() || '1';
            const parsed_qty = parseInt(qty_text, 10);
            if (!isNaN(parsed_qty)) {
              quantity = parsed_qty;
              console.log(`Item ${idx}: Extracted quantity: ${quantity}`);
            }
          }
        } catch (qty_err) {
          // No quantity label = 1 item (default)
        }

        if (asin) {
          console.log(`Item ${idx}: Successfully extracted - ${quantity}x ${asin}`);
          items_from_tracking.push({
            name: asin,
            quantity: quantity
          });
        } else {
          console.warn(`Item ${idx}: Could not extract ASIN, skipping`);
        }
      } catch (item_err) {
        console.warn(`Error extracting item ${idx} from tracking page:`, item_err);
      }
    });

    console.log(`Extracted ${items_from_tracking.length} items from tracking page`);
  } catch (err) {
    console.warn('Error extracting items from tracking page carousel:', err);
  }

  return {
    tracking_id: tracking_id || '',
    one_time_passcode: one_time_passcode,
    items_from_tracking: items_from_tracking
  };
}

async function get_tracking_data(
  amazon_tracking_url: string,
  scheduler: request_scheduler.IRequestScheduler,
): Promise<ITrackingPageData> {
  try {
    const data = await req.makeAsyncStaticRequest(
      amazon_tracking_url,
      'get_tracking_data',
      data_from_tracking_page,
      scheduler,
      '9999',
      false,  // nocache=false: cached response is acceptable
      'get_tracking_data',
    );
    // Strip "Tracking ID: " prefix if present
    const stripped_id = data.tracking_id.replace(/^.*: /, '');
    return {
      tracking_id: stripped_id,
      one_time_passcode: data.one_time_passcode,
      items_from_tracking: data.items_from_tracking
    };
  } catch (ex) {
    console.warn(
      'while trying to get tracking_data from', amazon_tracking_url, 'we got',
      ex
    );
    return {
      tracking_id: '',
      one_time_passcode: '',
      items_from_tracking: []
    };
  }
}

function extract_shipment_id(tracking_link: string): string {
  // https://www.amazon.co.uk/progress-tracker/package/ref=ppx_od_dt_b_track_package?_encoding=UTF8&itemId=lkpgkspopoluuo&orderId=202-1416149-4038736&packageIndex=0&shipmentId=DT7cMbTTr&vt=ORDER_DETAILS
  return tracking_link.replace(/.*shipmentId=/, '')
                      .replace(/&.*/, '');
}

function enthusiastically_strip(e: Node): string {
  return util.defaulted(e.textContent, '').replace(/\s\s+/g, ' ').trim();
}

function get_transactions(order_detail_doc_elem: HTMLElement): ITransaction[] {
  function strategy_a(): ITransaction[] {
    function transaction_from_elem(elem: HTMLElement): ITransaction {
      const info_string = enthusiastically_strip(elem.childNodes[0]);
      const payment_amount = enthusiastically_strip(elem.childNodes[1]);
      return {
        payment_amount: payment_amount,
        info_string: info_string,
      };
    }
    const transaction_elems = extraction.findMultipleNodeValues(
      "//span[normalize-space(text())='Transactions']/../../div[contains(@class, 'expander')]/div[contains(@class, 'a-row')]/span/nobr/..",
      order_detail_doc_elem);
    const transactions = transaction_elems.map(e => transaction_from_elem(e as HTMLElement));
    return transactions;
  }

  function strategy_b(): ITransaction[] {
    function transaction_from_elem(elem: HTMLElement): ITransaction {

      // 'December 17, 2023 - Visa ending in 8489: $41.49'
      const text = enthusiastically_strip(elem.childNodes[3])
        .replace(/\n/g, ' ')
        .replace(/(  *)/g, ' ');

      const payment_amount = text.replace(/.*: ?/, '');
      const info_string = text.replace(/:.*/, '');
      return {
        payment_amount: payment_amount,
        info_string: info_string,
      };
    }
    const transaction_elems = extraction.findMultipleNodeValues(
      "//span[normalize-space(text())='Transactions']/../../div[contains(@class, 'expander')]/div[contains(@class, 'a-row')]/span/..",
      order_detail_doc_elem);
    const transactions = transaction_elems.map(e => transaction_from_elem(e as HTMLElement));
    return transactions;
  }

  const result = extraction.firstMatchingStrategy(
    [strategy_a, strategy_b],
    [],
  );

  return result ? result : [];  // tslint whingeing about nulls.
}

function get_one_time_passcode(shipment_elem: HTMLElement): string {
  try {
    const text = util.defaulted(shipment_elem.textContent, '');
    // Match pattern: "Your one-time password is 907299"
    const match = text.match(/one-time password is (\d+)/i);
    if (match && match[1]) {
      return match[1];
    }
    return '';
  } catch(err) {
    console.log('shipment.one_time_passcode got ', err);
    return '';
  }
}

function get_tracking_id_from_text(shipment_elem: HTMLElement): string {
  try {
    const text = util.defaulted(shipment_elem.textContent, '');
    // Match pattern: "Tracking ID: TBA325431380846"
    const match = text.match(/Tracking ID:\s*([A-Z0-9]+)/i);
    if (match && match[1]) {
      return match[1];
    }
    return '';
  } catch(err) {
    console.log('shipment.get_tracking_id_from_text got ', err);
    return '';
  }
}

async function shipment_from_elem(
  shipment_elem: HTMLElement,
  order_header: order_header.IOrderHeader,
  context: string,
  scheduler: request_scheduler.IRequestScheduler,
  site: string,
): Promise<IShipment> {
  const tracking_link: string = get_tracking_link(shipment_elem, site);

  // Try to get tracking ID directly from the order page first
  let tracking_id: string = get_tracking_id_from_text(shipment_elem);
  let one_time_passcode: string = '';
  let items_from_tracking: ITrackingPageItem[] = [];

  // Fetch the tracking page if we have a tracking link
  // We need to do this to get the OTP and items which are only on the tracking page
  if (tracking_link !== '') {
    const tracking_data = await get_tracking_data(tracking_link, scheduler);

    // Use tracking ID from tracking page if we didn't find it on the order page
    if (tracking_id === '') {
      tracking_id = tracking_data.tracking_id;
    }

    // Get OTP from tracking page
    one_time_passcode = tracking_data.one_time_passcode;

    // Get items from tracking page
    items_from_tracking = tracking_data.items_from_tracking;
  }

  // Fallback: try to get OTP from shipment element (older format or different page layout)
  if (one_time_passcode === '') {
    one_time_passcode = get_one_time_passcode(shipment_elem);
  }

  const shipment_id = tracking_id != '' ?
                      extract_shipment_id(tracking_link) :
                      '';
  const refund: string = get_refund(shipment_elem);

  return {
    shipment_id: shipment_id,
    items: await item.extractItems(shipment_elem, order_header, scheduler, context),
    delivered: is_delivered(shipment_elem),
    status: get_status(shipment_elem),
    tracking_link: tracking_link,
    tracking_id: tracking_id,
    one_time_passcode: one_time_passcode,
    items_from_tracking: items_from_tracking,
    transaction: null,
    refund: refund,
  };
}

function get_refund(shipment_elem: HTMLElement): string {
  const refund = extraction.by_regex2(
    [
      ".//div[contains(@class, ' shipment')]//span[contains(text(), 'Refund for this return')]/../../../../..//span/text()"
    ],
    util.moneyRegEx(),
    '',
    shipment_elem,
    'shipment.refund'
  );
  return refund == null ? '' : refund;
}

function is_delivered(shipment_elem: HTMLElement): Delivered {
  const attr = shipment_elem.getAttribute('class');

  if ((attr as string).includes('shipment-is-delivered')) {
    return Delivered.YES;
  }

  const text = shipment_elem.textContent?.toLowerCase().trim() ?? '';

  if (text.includes('delivered')) {
    return Delivered.YES;
  }

  if (text.includes('arriving')) {
    return Delivered.NO;
  }

  return Delivered.UNKNOWN;
}

function get_status(shipment_elem: HTMLElement): string {
  try {
    const elem = extraction.findSingleNodeValue(
      [
        ".//div[contains(@class, 'shipment-info-container')]//div[@class='a-row']/span",
        ".//div[@data-component='shipmentStatus']",
      ].join('|'),
      shipment_elem,
      'shipment.status'
    );
    return util.defaulted((elem as HTMLElement)!.textContent!.trim(), '');
  } catch(err) {
    console.log('shipment.status got ', err);
    return 'UNKNOWN';
  }
}

function get_tracking_link(shipment_elem: HTMLElement, site: string): string {
  return util.defaulted_call(
    () => {
      const link_elem = extraction.findSingleNodeValue(
        [
          ".//a[contains(@href, '/progress-tracker/')]",
          ".//a[contains(@href, '/ship-track')]",
        ].join('|'),
        shipment_elem,
        'shipment.tracking_link'
      );
      const base_url = util.defaulted(
        (link_elem as HTMLElement).getAttribute('href'),
        ''
      );
      const full_url = url.normalizeUrl(base_url, site);
      return full_url;
    },
    ''
  );
}
