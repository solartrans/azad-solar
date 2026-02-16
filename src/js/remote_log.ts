/* Copyright(c) 2025 Philip Mulcahy. */

'use strict';

// Remote logging has been disabled
export async function log(
  msg: { [index: string]: string },
): Promise<void> {
  // No-op: remote logging disabled
  console.log('Remote logging disabled');
}
