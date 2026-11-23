#!/usr/bin/env node
// Issue a Lexora Pro license key. Pro is subscription-only: an expiry is required.
//   node sign.mjs --key private.pem --email a@b.c --months 12 [--price 68]
//   node sign.mjs --key private.pem --email a@b.c --exp 2027-12-31
// 每次签发自动追加到私钥同目录的 issued.jsonl（运维页「已签发订阅/收入」的数据源，
// 挂载到 worker 的 /data/issued.jsonl 即可展示）。
import { createPrivateKey, sign } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!args.key || !args.email || (!args.exp && !args.months)) {
  console.error('usage: node sign.mjs --key private.pem --email a@b.c (--months N | --exp YYYY-MM-DD)');
  process.exit(1);
}
let exp;
if (args.exp) {
  exp = new Date(args.exp + 'T23:59:59Z').getTime();
} else {
  const d = new Date();
  d.setMonth(d.getMonth() + Number(args.months));
  exp = d.getTime();
}
if (!Number.isFinite(exp) || exp <= Date.now()) {
  console.error('expiry must be a valid future date');
  process.exit(1);
}
const payload = { v: 1, plan: 'pro', email: args.email, iat: Date.now(), exp };
const msg = Buffer.from(JSON.stringify(payload), 'utf8');
const sig = sign(null, msg, createPrivateKey(readFileSync(args.key)));
const b64u = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
console.log(`LEXORA1.${b64u(msg)}.${b64u(sig)}`);
console.error(`  licensee: ${args.email}  expires: ${new Date(exp).toISOString().slice(0, 10)}`);
const ledger = join(dirname(args.key), 'issued.jsonl');
appendFileSync(ledger, JSON.stringify({ email: args.email, iat: payload.iat, exp, price: args.price ? Number(args.price) : undefined }) + '\n');
console.error(`  ledger: ${ledger}`);
