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
  delivered_status: Delivered;
  shipping_status: string;
}

export enum Delivered {
  YES = 1,
  NO = 2,
  UNKNOWN = 3,
  CANCELLED = 4,
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

  // Check if order is cancelled
  // HTML: <div data-component="cancelled">
  //       or <h4 class="a-alert-heading">This order has been cancelled.</h4>
  const is_cancelled = extraction.getField2(
    [
      '//div[@data-component="cancelled"]',
      '//h4[contains(@class, "a-alert-heading") and contains(text(), "cancelled")]',
    ],
    doc_elem,
    '',
    'cancelled_order_detection'
  );

  if (is_cancelled) {
    console.log('Detected cancelled order, returning synthetic CANCELLED shipment');
    // Return a single synthetic shipment indicating the order was cancelled
    const cancelled_shipment: IShipment = {
      shipment_id: '',
      items: await item.extractItems(doc_elem, order_header, scheduler, context),
      delivered: Delivered.CANCELLED,
      status: 'CANCELLED',
      tracking_link: '',
      tracking_id: '',
      one_time_passcode: '',
      items_from_tracking: [],
      transaction: transactions.length > 0 ? transactions[0] : null,
      refund: '',
    };
    return [cancelled_shipment];
  }

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
  // Normal format: <div class="pt-delivery-card-trackingId">Tracking ID: TBA...</div>
  // Late package format: <h4 class="carrierRelatedInfo-trackingId-text">Tracking ID: TBA...</h4>
  const tracking_id_raw: string|null = extraction.getField2(
    [
      "//div[contains(@class, 'pt-delivery-card-trackingId')]",
      "//h4[contains(@class, 'carrierRelatedInfo-trackingId-text')]",
      "//*[contains(@class, 'trackingId')][contains(text(), 'Tracking ID')]"
    ],
    body,
    '',
    'tracking_id_from_tracking_page'
  );

  // Extract just the tracking number from text like "Tracking ID: TBA325833760125"
  let tracking_id = '';
  if (tracking_id_raw) {
    const match = tracking_id_raw.match(/TBA\d+|1Z[A-Z0-9]+/);
    if (match) {
      tracking_id = match[0];
    } else {
      // Fallback: if no pattern match, remove "Tracking ID:" prefix
      tracking_id = tracking_id_raw.replace(/Tracking ID:\s*/i, '').trim();
    }
  }
  console.log(`Extracted tracking ID from tracking page: ${tracking_id}`);

  // Extract one-time passcode from alert content
  // Extract one-time passcode
  // HTML: <section class="pt-card map-banner-card">
  //         <div class="pt-notice-MAPS">
  //           <div class="a-alert-content">Your one-time password is 545565...</div>
  // Be specific to avoid matching wrong alert divs
  const otp_xpaths = [
    "//div[contains(@class, 'pt-notice-MAPS')]//div[contains(@class, 'a-alert-content')]",
    "//section[contains(@class, 'map-banner-card')]//div[contains(@class, 'a-alert-content')]",
    "//div[contains(@class, 'a-alert-content') and contains(text(), 'one-time password')]",
  ];
  const alert_content: string|null = extraction.getField2(
    otp_xpaths,
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
      console.log(`Extracted one-time passcode: ${one_time_passcode}`);
    } else {
      console.log(`Found alert content but couldn't match OTP pattern: ${alert_content.substring(0, 100)}`);
    }
  } else {
    console.log('No one-time passcode alert found on tracking page');
  }

  // Extract items from carousel
  // HTML: <div class="pt-floating-map-card"><ol class="a-carousel"><li class="a-carousel-card">...
  // Restrict to pt-floating-map-card to exclude suggested items and other carousels
  const items_from_tracking: ITrackingPageItem[] = [];

  // Try carousel format first (normal tracking pages)
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

    console.log(`Extracted ${items_from_tracking.length} items from tracking page carousel`);
  } catch (carousel_err) {
    console.warn('Carousel extraction failed or found no items:', carousel_err);
  }

  // Fallback: Try alternative format for late/delayed packages
  // HTML: <div id="itemImagesCarousel-container"><div class="itemImages-inline"><a href="/gp/product/B0BLS3Y632?...">
  if (items_from_tracking.length === 0) {
    console.log('No items found in carousel, trying alternative format for late packages...');
    try {
      const alt_items = extraction.findMultipleNodeValues(
        "//div[@id='itemImagesCarousel-container']//a[contains(@href, '/gp/product/')]",
        body
      );

      console.log(`Found ${alt_items.length} items in alternative format`);

      alt_items.forEach((item_elem: Node, idx: number) => {
        try {
          const href_attr = (item_elem as HTMLElement)?.getAttribute('href') || '';
          console.log(`Alt format item ${idx}: href attribute = ${href_attr}`);
          const asin_match = href_attr.match(/\/gp\/product\/([A-Z0-9]+)/);
          if (asin_match && asin_match[1]) {
            const asin = asin_match[1];

            // Extract quantity from <span class="itemImages-quantityLabel">3</span>
            // This span is a sibling of the <a> tag in the parent container
            let quantity = 1;  // Default to 1 if not found
            try {
              const parent = (item_elem as HTMLElement)?.parentElement;
              if (parent) {
                const qty_span = parent.querySelector('.itemImages-quantityLabel');
                if (qty_span) {
                  const qty_text = qty_span.textContent?.trim() || '1';
                  const parsed_qty = parseInt(qty_text, 10);
                  if (!isNaN(parsed_qty)) {
                    quantity = parsed_qty;
                    console.log(`Alt format item ${idx}: Extracted quantity from itemImages-quantityLabel: ${quantity}`);
                  }
                }
              }
            } catch (qty_err) {
              console.log(`Alt format item ${idx}: Could not extract quantity, using default 1`);
            }

            console.log(`Alt format item ${idx}: Extracted ${quantity}x ${asin}`);
            items_from_tracking.push({
              name: asin,
              quantity: quantity
            });
          } else {
            console.warn(`Alt format item ${idx}: No ASIN match in href: ${href_attr}`);
          }
        } catch (item_err) {
          console.warn(`Error extracting alt format item ${idx}:`, item_err);
        }
      });

      console.log(`Extracted ${items_from_tracking.length} items from alternative format`);
    } catch (alt_err) {
      console.warn('Alternative format extraction also failed:', alt_err);
    }
  }

  // Extract delivered status from tracking page
  // HTML: <h1 class="pt-promise-main-slot">Delivered October 23</h1>
  // or: <h1 class="pt-promise-main-slot">Arriving today</h1>
  let delivered_status = Delivered.UNKNOWN;
  const promise_text_raw = extraction.getField2(
    [
      "//h1[contains(@class, 'pt-promise-main-slot')]",
      "//span[@id='primaryStatus']"
    ],
    body,
    '',
    'delivered_status_from_tracking_page'
  );

  // Extract shipping status from status card
  // HTML: <h1 class="pt-status-main-status">Ordered</h1>
  // or: <h1 class="pt-status-main-status">Shipped</h1>
  // or: <h1 class="pt-status-main-status">Delivered</h1>
  const status_card_text_raw = extraction.getField2(
    [
      "//h1[contains(@class, 'pt-status-main-status')]"
    ],
    body,
    '',
    'status_from_tracking_page'
  );

  if (promise_text_raw) {
    const promise_text = promise_text_raw.toLowerCase();
    console.log(`Tracking page promise text: "${promise_text}"`);

    if (promise_text.includes('delivered')) {
      delivered_status = Delivered.YES;
      console.log('Tracking page shows: DELIVERED');
    } else if (tracking_id && tracking_id !== '') {
      // Has tracking number but not delivered yet
      delivered_status = Delivered.NO;
      console.log('Tracking page shows: SHIPPED but not delivered');
    } else if (status_card_text_raw) {
      // Check the status card for "Ordered" or "Shipped" status
      const status_text = status_card_text_raw.toLowerCase().trim();
      console.log(`Tracking page status card text: "${status_text}"`);

      if (status_text === 'ordered' || status_text === 'shipped') {
        // Package has been ordered/shipped but not yet delivered
        delivered_status = Delivered.NO;
        console.log(`Tracking page shows: ${status_text.toUpperCase()} but not delivered`);
      }
    }
  } else {
    console.log('No promise text found on tracking page');
  }

  // Extract shipping status text (for display in status column)
  // Use the same promise_text_raw which contains text like "Delivered October 23" or "Arriving today"
  const shipping_status = promise_text_raw || '';
  console.log(`Shipping status from tracking page: "${shipping_status}"`);

  return {
    tracking_id: tracking_id || '',
    one_time_passcode: one_time_passcode,
    items_from_tracking: items_from_tracking,
    delivered_status: delivered_status,
    shipping_status: shipping_status
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
      items_from_tracking: data.items_from_tracking,
      delivered_status: data.delivered_status,
      shipping_status: data.shipping_status
    };
  } catch (ex) {
    console.warn(
      'while trying to get tracking_data from', amazon_tracking_url, 'we got',
      ex
    );
    return {
      tracking_id: '',
      one_time_passcode: '',
      items_from_tracking: [],
      delivered_status: Delivered.UNKNOWN,
      shipping_status: ''
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
  console.log(`Tracking ID from order page: "${tracking_id}"`);

  let one_time_passcode: string = '';
  let items_from_tracking: ITrackingPageItem[] = [];
  let delivered_from_tracking: Delivered | null = null;
  let status_from_tracking: string = '';

  // Fetch the tracking page if we have a tracking link
  // We need to do this to get the OTP, items, and accurate delivered status from tracking page
  if (tracking_link !== '') {
    const tracking_data = await get_tracking_data(tracking_link, scheduler);

    // Use tracking ID from tracking page if we didn't find it on the order page
    if (tracking_id === '') {
      tracking_id = tracking_data.tracking_id;
      console.log(`Using tracking ID from tracking page: "${tracking_id}"`);
    } else {
      console.log(`Keeping tracking ID from order page: "${tracking_id}"`);
    }

    // Get OTP from tracking page
    one_time_passcode = tracking_data.one_time_passcode;

    // Get items from tracking page
    items_from_tracking = tracking_data.items_from_tracking;

    // Get delivered status from tracking page (more accurate than order page)
    delivered_from_tracking = tracking_data.delivered_status;

    // Get shipping status from tracking page
    status_from_tracking = tracking_data.shipping_status;
  }

  // Fallback: try to get OTP from shipment element (older format or different page layout)
  if (one_time_passcode === '') {
    one_time_passcode = get_one_time_passcode(shipment_elem);
  }

  const shipment_id = tracking_id != '' ?
                      extract_shipment_id(tracking_link) :
                      '';
  const refund: string = get_refund(shipment_elem);

  // Prefer delivered status from tracking page (more accurate) over order page
  const delivered_status = delivered_from_tracking !== null ?
                            delivered_from_tracking :
                            is_delivered(shipment_elem, tracking_id);

  console.log(`Final delivered status: ${Delivered[delivered_status]} (from tracking: ${delivered_from_tracking !== null})`);

  // Prefer shipping status from tracking page (more accurate) over order page
  const status = status_from_tracking !== '' ?
                 status_from_tracking :
                 get_status(shipment_elem);

  console.log(`Final shipping status: "${status}" (from tracking: ${status_from_tracking !== ''})`);

  return {
    shipment_id: shipment_id,
    items: await item.extractItems(shipment_elem, order_header, scheduler, context),
    delivered: delivered_status,
    status: status,
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

function is_delivered(shipment_elem: HTMLElement, tracking_id: string): Delivered {
  console.log(`is_delivered() called with tracking_id: "${tracking_id}"`);

  const attr = shipment_elem.getAttribute('class');

  // Check for explicit delivered status
  if ((attr as string).includes('shipment-is-delivered')) {
    console.log('Detected as delivered (class check)');
    return Delivered.YES;
  }

  const text = shipment_elem.textContent?.toLowerCase().trim() ?? '';

  // Check for delivered text
  if (text.includes('delivered')) {
    console.log('Detected as delivered (text check)');
    return Delivered.YES;
  }

  // If there's a tracking number, the package has been shipped (but not delivered)
  if (tracking_id && tracking_id !== '') {
    console.log(`Detected as shipped but not delivered (has tracking_id: "${tracking_id}")`);
    return Delivered.NO;
  }

  console.log('Could not determine delivery status, returning UNKNOWN');
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
    const raw_text = (elem as HTMLElement)!.textContent!;
    // Clean up excessive whitespace: replace multiple spaces/newlines with single newline
    // Example: "Now arriving November 17\n            \n        \n        \n            Previously expected November 18"
    // Becomes: "Now arriving November 17\nPreviously expected November 18"
    const cleaned = raw_text
      .trim()
      .replace(/\s*\n\s*/g, '\n')  // Remove whitespace around newlines
      .replace(/\n{2,}/g, '\n');    // Replace multiple newlines with single newline
    return util.defaulted(cleaned, '');
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
