// check-mongo.mjs — run from Desktop\citycare-web\server :  node check-mongo.mjs
// Prints the parts of MONGODB_URI (password hidden), flags common mistakes, then tries to connect.
import 'dotenv/config';
import mongoose from 'mongoose';

const uri = (process.env.MONGODB_URI || '').trim();
if (!uri) { console.log('MONGODB_URI is empty or missing in server\\.env'); process.exit(1); }

const m = uri.match(/^(mongodb(?:\+srv)?):\/\/([^:@/]*)(?::([^@]*))?@([^/?]+)\/?([^?]*)(\?.*)?$/);
if (!m) { console.log('MONGODB_URI does not look like mongodb+srv://USER:PASSWORD@HOST/DB?...'); process.exit(1); }
const [, scheme, user, pass = '', host, db] = m;

console.log('scheme   :', scheme);
console.log('username :', JSON.stringify(user));
console.log('password :', pass ? `${pass.length} characters (hidden)` : 'MISSING');
console.log('host     :', host);
console.log('database :', db || '(none — add /citycare after .mongodb.net)');

const problems = [];
if (/[<>]/.test(uri)) problems.push('contains < or > — remove the angle brackets around the password');
if (/db_password/i.test(pass)) problems.push('password is still the placeholder "db_password"');
if (/["'\s]/.test(uri)) problems.push('contains a space or quote — remove it');
if (/[@#/:?]/.test(decodeURIComponent(pass)) && !/%/.test(pass)) problems.push('password has @ # / : or ? — change the password to letters+numbers only');
console.log(problems.length ? '\nPROBLEMS:\n - ' + problems.join('\n - ') : '\nNo obvious typos found.');

console.log('\nTrying to connect...');
try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log('SUCCESS: connected to MongoDB');
} catch (e) {
  console.log('FAILED:', e.message);
  if (/auth/i.test(e.message)) console.log('-> Username or password is wrong. Check Atlas > Database Users, reset the password, wait 1 minute.');
}
await mongoose.disconnect();
