// Sets a user's password from the command line, for when nobody can sign in.
//
//   node server/src/tools/reset-password.ts admin                 # prints a new random password
//   node server/src/tools/reset-password.ts admin 'new password'
//   docker exec sasbench node server/src/tools/reset-password.ts admin
//
// The account is enabled and signed out everywhere; its API keys keep working. A user name that
// does not exist is created as an admin. Works while the SAS is running (SAS_DATA_DIR, else ./data).
import crypto from 'node:crypto';
import path from 'node:path';
import { Db } from '../db.ts';
import { Sessions, UserError, Users, checkNewPassword } from '../auth/users.ts';

const [username, given, ...rest] = process.argv.slice(2);
if (!username || rest.length || username.startsWith('-')) {
  console.error('usage: reset-password.ts USERNAME [PASSWORD]   (without PASSWORD, a random one is printed)');
  process.exit(2);
}

const db = new Db(path.join(path.resolve(process.env.SAS_DATA_DIR ?? './data'), 'sas.db'));
const users = new Users(db);
const password = given ?? crypto.randomBytes(12).toString('base64url');
try {
  checkNewPassword(password);
  const row = users.row(username);
  if (row) {
    await users.setPassword(row.id, password);
    if (!row.enabled) users.update(row.id, { enabled: true });
    const n = new Sessions(db).revokeUser(row.id);
    console.log(`Password set for ${row.username} (${row.role})${row.enabled ? '' : '; the account is enabled again'}; ${n} session${n === 1 ? '' : 's'} ended.`);
  } else {
    const u = await users.create({ username, password, role: 'admin' });
    console.log(`Created admin user ${u.username}.`);
  }
  if (!given) console.log(`New password: ${password}`);
} catch (e) {
  console.error(e instanceof UserError ? `${e.field === 'password' ? 'Password' : 'User name'}: ${e.message}` : e);
  process.exit(1);
}
