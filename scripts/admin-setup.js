#!/usr/bin/env node
// One-time setup for the Last Call Superadmin.
//
//   npm run admin:setup
//
// Asks for a username and a password (typed without echo), then prints the
// three values to set as environment variables on the server:
// ADMIN_USERNAME, ADMIN_PASSWORD_HASH and ADMIN_TOTP_SECRET. The password
// itself is never printed or stored; only its scrypt hash. Add the TOTP secret
// to an authenticator app (1Password, Google Authenticator, Authy, Aegis…).
//
// Non-interactive use: pipe two lines, the username then the password.

import { createInterface } from 'node:readline';
import { hashPassword, newTotpSecret, otpauthUri, totpCode, base32Decode, MIN_PASSWORD_LENGTH, TOTP_STEP_MS } from '../server/auth.js';

const tty = process.stdin.isTTY;

let ask = function (rl, question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    if (!hidden || !tty) {
      rl.question(question, resolve);
      return;
    }
    // Hide what is typed: print the prompt ourselves and mute the echo.
    const write = rl._writeToOutput;
    rl._writeToOutput = (s) => (s.startsWith(question) ? write.call(rl, question) : undefined);
    rl.question(question, (answer) => {
      rl._writeToOutput = write;
      process.stdout.write('\n');
      resolve(answer);
    });
  });
};

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
// Piped input: lines can arrive before the prompts that want them, so queue them.
const piped = [];
const waiting = [];
if (!tty) {
  rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : piped.push(line)));
  rl.on('close', () => waiting.splice(0).forEach((resolve) => resolve('')));
  ask = (_rl, question) => {
    process.stdout.write(question);
    return piped.length ? Promise.resolve(piped.shift()) : new Promise((resolve) => waiting.push(resolve));
  };
}
try {
  const username = (await ask(rl, 'Admin username: ')).trim();
  if (!/^[A-Za-z0-9._@-]{3,64}$/.test(username)) throw new Error('use 3 to 64 letters, digits, dots, dashes, underscores or @');
  const password = await ask(rl, `Password (at least ${MIN_PASSWORD_LENGTH} characters): `, { hidden: true });
  if (tty) {
    const again = await ask(rl, 'Type the password again: ', { hidden: true });
    if (again !== password) throw new Error('the passwords did not match');
  }
  const hash = await hashPassword(password);
  const secret = newTotpSecret();

  console.log('\nSet these as environment variables on the server (Render: the service\'s Environment tab).');
  console.log('Treat them as secrets: never commit them or paste them into chat.\n');
  console.log(`ADMIN_USERNAME=${username}`);
  console.log(`ADMIN_PASSWORD_HASH=${hash}`);
  console.log(`ADMIN_TOTP_SECRET=${secret}`);
  console.log('\nAdd the one-time code to your authenticator app with this key:');
  console.log(`  ${secret.match(/.{1,4}/g).join(' ')}`);
  console.log('or this link (many apps accept it pasted, or as a QR code you make locally):');
  console.log(`  ${otpauthUri({ secret, account: username })}`);

  if (tty) {
    const code = (await ask(rl, '\nTo check the app is set up, type the 6-digit code it shows (or press Enter to skip): ')).trim();
    if (code) {
      const step = Math.floor(Date.now() / TOTP_STEP_MS);
      const key = base32Decode(secret);
      const ok = [step - 1, step, step + 1].some((s) => totpCode(key, s) === code);
      console.log(ok ? 'That code is right. The app is set up.' : 'That code did not match. Check the key in your app and the clock on your device.');
    }
  }
} catch (err) {
  console.error(`\nAdmin setup stopped: ${err.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
}
