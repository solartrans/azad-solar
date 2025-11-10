/* Copyright(c) 2017-2021 Philip Mulcahy. */

'use strict';

import * as item from './item';
import * as order from './order';
import * as shipment from './shipment';
import * as util from './util';

export interface IEnrichedShipment extends shipment.IShipment {
  order: order.ISyncOrder;
  additional_order_ids?: string[];
}

export interface IEnrichedItem extends item.IItem {
  shipment: shipment.IShipment;
}

export async function enriched_shipments_from_orders(
  orders: order.IOrder[]
): Promise<IEnrichedShipment[]> {
  const oop = orders.map(o => o.sync());
  const oo = await util.get_settled_and_discard_rejects(oop);
  const all_shipments: IEnrichedShipment[] = oo.flatMap( o => {
    const ss = o.shipments;
    if (ss.length == 0) {
      ss.push({
        shipment_id: '',
        items: o.item_list,
        delivered: shipment.Delivered.UNKNOWN,
        status: 'no shipment',
        tracking_link: '',
        tracking_id: '',
        one_time_passcode: '',
        items_from_tracking: [],
        transaction: null,
        refund: '',
      });
    }
    return ss.map( s => ({
      shipment_id: s.shipment_id,
      order: o,
      items: s.items,
      delivered: s.delivered,
      status: s.status,
      tracking_link: s.tracking_link,
      tracking_id: s.tracking_id,
      one_time_passcode: s.one_time_passcode,
      items_from_tracking: s.items_from_tracking,
      transaction: s.transaction,
      refund: s.refund,
      additional_order_ids: [],
    }));
  });

  // Deduplicate by tracking_id: keep first chronologically, add other order IDs to additional_order_ids
  // BUT: only deduplicate when tracking_id is non-empty. Empty tracking_id means not shipped yet,
  // and each shipment should appear as a separate row.
  const tracking_id_map = new Map<string, IEnrichedShipment[]>();
  const no_tracking_shipments: IEnrichedShipment[] = [];

  // Separate shipments with tracking from those without
  all_shipments.forEach(s => {
    const tracking_id = s.tracking_id || '';
    if (tracking_id === '') {
      // No tracking number yet - keep all of these as separate rows
      no_tracking_shipments.push(s);
    } else {
      // Has tracking number - group for deduplication
      if (!tracking_id_map.has(tracking_id)) {
        tracking_id_map.set(tracking_id, []);
      }
      tracking_id_map.get(tracking_id)!.push(s);
    }
  });

  // For each tracking_id group, keep first chronologically and collect additional order IDs
  const deduplicated_shipments: IEnrichedShipment[] = [];

  tracking_id_map.forEach((group, tracking_id) => {
    if (group.length === 1) {
      // No duplicates, just add it
      deduplicated_shipments.push(group[0]);
    } else {
      // Sort by order date (chronologically)
      group.sort((a, b) => {
        const date_a = new Date(a.order.date).getTime();
        const date_b = new Date(b.order.date).getTime();
        return date_a - date_b;
      });

      // Keep the first one
      const first_shipment = group[0];

      // Collect additional order IDs from the rest
      const additional_ids = group.slice(1).map(s => s.order.id);
      first_shipment.additional_order_ids = additional_ids;

      deduplicated_shipments.push(first_shipment);
    }
  });

  // Add all no-tracking shipments (these are never deduplicated)
  return [...deduplicated_shipments, ...no_tracking_shipments];
}

export async function enriched_items_from_orders(
  orders: order.IOrder[],
): Promise<IEnrichedItem[]> {
  const shipments = await enriched_shipments_from_orders(orders);
  const items: IEnrichedItem[] = shipments.flatMap( s => {
    const ii = s.items;
    return ii.map( i => ({
      shipment: s,
      description: i.description,
      price: i.price,
      quantity: i.quantity,
      url: i.url,
      asin: i.asin,
      order_header: i.order_header,
      category: i.category,
    }));
  });
  return items;
}
