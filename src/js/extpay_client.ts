/* Copyright(c) 2023 Philip Mulcahy. */

'use strict';

// ExtensionPay has been disabled - all features are now free

export async function check_authorised(): Promise<boolean> {
  console.log('extpay_client.check_authorised() called - always returning true (ExtensionPay disabled)');
  return true; // All features are now free
}

export async function display_payment_ui() {
  console.log('Payment UI disabled - ExtensionPay removed');
}

export async function display_login_page() {
  console.log('Login page disabled - ExtensionPay removed');
}

export async function display_console() {
  console.log('Console disabled - ExtensionPay removed');
}

export async function getLoginId(): Promise<string> {
  return 'anonymous'; // No user tracking
}
