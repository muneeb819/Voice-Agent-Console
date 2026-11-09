/**
 * Account lifecycle regressions: password policy, password change with session
 * invalidation, revoke-all, account disable, role changes and last-owner
 * protection. Closes audit findings A-04 and A-05.
 *
 * Runs entirely on loopback with synthetic accounts; no live provider or PBX.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-account-lifecycle-'));
process.env.VAC_DATA_DIR = dataDir;
process.env.VAC_ENV_FILE = path.join(dataDir, '.env');
process.env.ADMIN_PASSWORD = '';
process.env.TRUST_PROXY = '';

const json = { 'Content-Type': 'application/json' };

async function main() {
  // Import after the data dir is set so the store opens the synthetic database.
  const { createApp } = await import('../src/server');
  const {
    createUser, createUserSession, getUserBySessionToken, validatePassword,
    listUsers, countUserSessions, destroyUserSessions, changeUserPassword,
    setUserActive, setUserRole, authenticateUser,
  } = await import('../src/user-store');
  const { invalidateUserCountCache } = await import('../src/auth-guard');
  const { getDb } = await import('../src/db');

  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = (p: string, method = 'GET', cookie = '', body?: unknown) =>
    fetch(base + p, {
      method,
      headers: { ...(body === undefined ? {} : json), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  try {
    // ---------------------------------------------------------- A-05 policy
    assert.match(String(validatePassword('Short-123!')), /at least 15/);
    assert.equal(validatePassword('correct-horse-battery'), null);
    const weak = await createUser({ email: 'weak@example.test', fullName: 'Weak Pass', password: 'Short-123!' });
    assert.equal(weak.ok, false);
    assert.equal(weak.field, 'password');

    const ownerPass = 'Owner-Passphrase-2026!';
    const owner = await createUser({ email: 'owner@example.test', fullName: 'Owner Person', password: ownerPass });
    const operator = await createUser({ email: 'operator@example.test', fullName: 'Operator Person', password: 'Operator-Passphrase-2026!' });
    const viewer = await createUser({ email: 'viewer@example.test', fullName: 'Viewer Person', password: 'Viewer-Passphrase-2026!' });
    assert.ok(owner.ok && operator.ok && viewer.ok);
    assert.equal(owner.user!.role, 'owner');
    setUserRole(viewer.user!.id, 'viewer');
    invalidateUserCountCache();

    // A pre-existing shorter hash must keep working: the policy gates new and
    // changed passwords, it does not lock out an already provisioned account.
    getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run((getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(operator.user!.id) as any).password_hash, operator.user!.id);
    assert.ok(await authenticateUser('operator@example.test', 'Operator-Passphrase-2026!'));

    const ownerCookie = `vac_session=${createUserSession(owner.user!.id)}`;
    const operatorToken = createUserSession(operator.user!.id);
    const operatorCookie = `vac_session=${operatorToken}`;
    const viewerCookie = `vac_session=${createUserSession(viewer.user!.id)}`;

    // -------------------------------------------- authorization on new routes
    for (const p of ['/api/users', '/api/USERS/', '/api/users']) {
      assert.equal((await call(p, 'GET', operatorCookie)).status, 403, p);
    }
    assert.equal((await call(`/api/users/${operator.user!.id}/status`, 'POST', operatorCookie, { active: false })).status, 403);
    assert.equal((await call(`/api/users/${operator.user!.id}/role`, 'POST', viewerCookie, { role: 'owner' })).status, 403);
    assert.equal((await call(`/api/users/${operator.user!.id}/revoke-sessions`, 'POST', operatorCookie, {})).status, 403);
    assert.equal((await call('/api/users')).status, 401, 'anonymous account listing is rejected');
    assert.equal((await call('/api/auth/change-password', 'POST', '', { currentPassword: 'x', newPassword: 'y' })).status, 403);
    assert.equal((await call('/api/auth/sessions', 'GET', operatorCookie, undefined)).status, 200);
    console.log('✓ Password policy rejects short new passwords; account administration is owner/admin only');

    // ------------------------------------------------ A-04 password change
    const otherDeviceToken = createUserSession(operator.user!.id);
    assert.equal(countUserSessions(operator.user!.id), 2);
    const wrong = await call('/api/auth/change-password', 'POST', operatorCookie, {
      currentPassword: 'not-the-password', newPassword: 'Rotated-Passphrase-2026!',
    });
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json() as any).field, 'currentPassword');
    const tooShort = await call('/api/auth/change-password', 'POST', operatorCookie, {
      currentPassword: 'Operator-Passphrase-2026!', newPassword: 'tiny',
    });
    assert.equal(tooShort.status, 400);
    assert.equal((await tooShort.json() as any).field, 'newPassword');
    assert.ok(getUserBySessionToken(otherDeviceToken), 'a failed change must not revoke sessions');

    const changed = await call('/api/auth/change-password', 'POST', operatorCookie, {
      currentPassword: 'Operator-Passphrase-2026!', newPassword: 'Rotated-Passphrase-2026!',
    });
    assert.equal(changed.status, 200);
    const changedBody = await changed.json() as any;
    assert.equal(changedBody.revokedSessions, 1);
    assert.equal(getUserBySessionToken(otherDeviceToken), null, 'other devices are signed out');
    assert.ok(getUserBySessionToken(operatorToken), 'the acting session survives');
    assert.equal(await authenticateUser('operator@example.test', 'Operator-Passphrase-2026!'), null);
    assert.ok(await authenticateUser('operator@example.test', 'Rotated-Passphrase-2026!'));
    assert.equal((await call('/api/state', 'GET', `vac_session=${otherDeviceToken}`)).status, 401);
    console.log('✓ Password change verifies the current password, rotates the hash and revokes other sessions');

    // ------------------------------------------------------- revoke-all
    const secondToken = createUserSession(operator.user!.id);
    const revoked = await call('/api/auth/revoke-sessions', 'POST', operatorCookie, { keepCurrent: true });
    assert.equal((await revoked.json() as any).revokedSessions, 1);
    assert.equal(getUserBySessionToken(secondToken), null);
    assert.ok(getUserBySessionToken(operatorToken));
    const fullToken = createUserSession(operator.user!.id);
    const signOutEverywhere = await call('/api/auth/revoke-sessions', 'POST', `vac_session=${fullToken}`, { keepCurrent: false });
    const signOutBody = await signOutEverywhere.json() as any;
    assert.equal(signOutBody.authenticated, false);
    assert.match(String(signOutEverywhere.headers.get('set-cookie')), /Max-Age=0/);
    assert.equal(getUserBySessionToken(fullToken), null);
    // An admin-password session has no account row and must not 500 here.
    process.env.ADMIN_PASSWORD = 'lifecycle-admin-password';
    const adminLogin = await call('/api/auth/login', 'POST', '', { password: 'lifecycle-admin-password' });
    const adminCookie = String(adminLogin.headers.get('set-cookie')).split(';')[0];
    assert.equal((await call('/api/auth/change-password', 'POST', adminCookie, { currentPassword: 'a', newPassword: 'b' })).status, 403);
    assert.equal((await call('/api/auth/revoke-sessions', 'POST', adminCookie, {})).status, 403);
    assert.equal((await call('/api/users', 'GET', adminCookie)).status, 200, 'legacy admin session stays owner-equivalent');
    process.env.ADMIN_PASSWORD = '';
    console.log('✓ Revoke-all supports keep-current and sign-out-everywhere without breaking admin-password sessions');

    // ------------------------------------------- disable + last-owner guard
    const badBody = await call(`/api/users/${operator.user!.id}/status`, 'POST', ownerCookie, { active: 'no' });
    assert.equal(badBody.status, 400);
    const liveToken = createUserSession(operator.user!.id);
    const disabled = await call(`/api/users/${operator.user!.id}/status`, 'POST', ownerCookie, { active: false });
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json() as any).user.active, false);
    assert.equal(getUserBySessionToken(liveToken), null, 'disabling revokes live sessions');
    assert.equal((await call('/api/state', 'GET', `vac_session=${liveToken}`)).status, 401);
    assert.equal(await authenticateUser('operator@example.test', 'Rotated-Passphrase-2026!'), null, 'disabled account cannot sign in');
    const relogin = await call('/api/auth/login', 'POST', '', { email: 'operator@example.test', password: 'Rotated-Passphrase-2026!' });
    assert.equal(relogin.status, 401);
    assert.equal((await call(`/api/users/${owner.user!.id}/status`, 'POST', ownerCookie, { active: false })).status, 409, 'last active owner is protected');
    assert.equal((await call(`/api/users/${owner.user!.id}/role`, 'POST', ownerCookie, { role: 'viewer' })).status, 409, 'last active owner cannot be demoted');
    assert.equal((await call(`/api/users/${operator.user!.id}/role`, 'POST', ownerCookie, { role: 'astronaut' })).status, 400);
    assert.equal((await call('/api/users/does-not-exist/status', 'POST', ownerCookie, { active: true })).status, 404);
    assert.equal((await call(`/api/users/${operator.user!.id}/status`, 'POST', ownerCookie, { active: true })).status, 200);
    assert.ok(await authenticateUser('operator@example.test', 'Rotated-Passphrase-2026!'), 're-enabled account can sign in again');
    console.log('✓ Account disable revokes access immediately; the last active owner cannot be locked out');

    // ------------------------------------------------ role change + listing
    const demoteToken = createUserSession(operator.user!.id);
    const demoted = await call(`/api/users/${operator.user!.id}/role`, 'POST', ownerCookie, { role: 'viewer' });
    assert.equal((await demoted.json() as any).user.role, 'viewer');
    assert.equal(getUserBySessionToken(demoteToken), null, 'demotion drops cached privileges');
    const viewerNow = `vac_session=${createUserSession(operator.user!.id)}`;
    assert.equal((await call('/api/state', 'GET', viewerNow)).status, 200);
    assert.equal((await call('/api/state/reset', 'POST', viewerNow, {})).status, 403);
    assert.equal((await call(`/api/users/${operator.user!.id}/revoke-sessions`, 'POST', ownerCookie, {})).status, 200);
    assert.equal(countUserSessions(operator.user!.id), 0);

    const listing = await call('/api/users', 'GET', ownerCookie);
    const listingBody = await listing.json() as any;
    assert.ok(Array.isArray(listingBody.users) && listingBody.users.length >= 3);
    assert.ok(listingBody.users.every((u: any) => typeof u.activeSessions === 'number'));
    assert.ok(!JSON.stringify(listingBody).includes('password_hash'), 'listing never exposes password hashes');
    assert.ok(!JSON.stringify(listingBody).includes('scrypt$'));
    assert.equal(listUsers().length, listingBody.users.length);
    assert.equal(destroyUserSessions('missing-account'), 0);
    const direct = await changeUserPassword('missing-account', 'a', 'b');
    assert.equal(direct.ok, false);
    assert.equal(setUserActive('missing-account', false).ok, false);
    assert.equal(setUserRole('missing-account', 'admin').ok, false);
    console.log('✓ Role changes invalidate old privileges and the account listing exposes no credentials');

    // ------------------------------- admin cannot escape into owner territory
    const admin = await createUser({ email: 'admin@example.test', fullName: 'Admin Person', password: 'Admin-Passphrase-2026!' });
    assert.ok(admin.ok);
    setUserRole(admin.user!.id, 'admin');
    const adminAccountCookie = `vac_session=${createUserSession(admin.user!.id)}`;
    assert.equal((await call('/api/users', 'GET', adminAccountCookie)).status, 200);
    assert.equal((await call(`/api/users/${owner.user!.id}/status`, 'POST', adminAccountCookie, { active: false })).status, 403,
      'an admin cannot disable an owner');
    assert.equal((await call(`/api/users/${owner.user!.id}/role`, 'POST', adminAccountCookie, { role: 'viewer' })).status, 403,
      'an admin cannot demote an owner');
    assert.equal((await call(`/api/users/${owner.user!.id}/revoke-sessions`, 'POST', adminAccountCookie, {})).status, 403,
      'an admin cannot revoke an owner session');
    assert.equal((await call(`/api/users/${admin.user!.id}/role`, 'POST', adminAccountCookie, { role: 'owner' })).status, 403,
      'an admin cannot grant itself ownership');
    assert.equal((await call(`/api/users/${operator.user!.id}/role`, 'POST', adminAccountCookie, { role: 'operator' })).status, 200,
      'an admin still manages non-owner accounts');
    assert.equal((await call(`/api/users/${owner.user!.id}/role`, 'POST', ownerCookie, { role: 'owner' })).status, 200);
    console.log('✓ Admins manage non-owner accounts but cannot disable, demote or become an owner');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log('ALL ACCOUNT LIFECYCLE CHECKS PASSED');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
