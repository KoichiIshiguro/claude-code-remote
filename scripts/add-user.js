#!/usr/bin/env node
'use strict';
// Add (or remove) a login account besides the admin.
//   node scripts/add-user.js <username> <password>
//   node scripts/add-user.js --remove <username>
// Takes effect on the next login — no server restart needed.
const auth = require('../src/auth');

const [a, b, c] = process.argv.slice(2);
try {
  if (a === '--remove') {
    if (!b) throw new Error('usage: add-user.js --remove <username>');
    console.log(auth.removeUser(b) ? `removed "${b}"` : `no such user "${b}"`);
  } else {
    if (!a || !b || c !== undefined) throw new Error('usage: add-user.js <username> <password>');
    auth.addUser(a, b);
    console.log(`added "${a}"`);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
