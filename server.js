import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { nodeVersionError } from './lib/node-version.js';

const versionError = nodeVersionError();
if (versionError) {
  console.error(versionError);
  process.exit(1);
}

const http = await import('./lib/http.js');

export const createApp = http.createApp;
export const clientAddress = http.clientAddress;
export const trustCloudflareFromEnv = http.trustCloudflareFromEnv;
export const productionConfigError = http.productionConfigError;
export const PAYMENT_UNAVAILABLE = http.PAYMENT_UNAVAILABLE;
export const SUMMARY_UNAVAILABLE = http.SUMMARY_UNAVAILABLE;
export const WALLET_MISMATCH = http.WALLET_MISMATCH;

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) http.main();
