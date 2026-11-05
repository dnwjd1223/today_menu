const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]).filter(Boolean);
const tick = () => new Promise(resolve => setImmediate(resolve));
const session = { user: { email: 'cook@example.com' } };

function configRequest(env, method = 'GET') {
  const sandbox = { module: { exports: {} }, process: { env }, Buffer, URL };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'api/config.js'), 'utf8'), sandbox);
  const response = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  sandbox.module.exports({ method }, response);
  return response;
}

async function authPage(options = {}) {
  const nodes = {};
  const calls = [];
  let authListener;
  class Element {
    constructor() { this.listeners = {}; this.dataset = {}; this.value = ''; this.hidden = false; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    setAttribute() {}
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.close?.(); }
    reportValidity() { return true; }
    reset() {}
  }
  const auth = {
    getSession: async () => ({ data: { session: options.session || null }, error: null }),
    onAuthStateChange: listener => { authListener = listener; },
    signInWithPassword: async credentials => { calls.push(['login', credentials]); return options.loginResult || { data: { session }, error: null }; },
    signUp: async credentials => { calls.push(['signup', credentials]); return options.signupResult || { data: { session: null }, error: null }; },
    signOut: async settings => { calls.push(['logout', settings]); return { error: options.logoutError || null }; }
  };
  const sandbox = {
    handleFavoriteSession() {},
    document: { querySelector: selector => nodes[selector] ||= new Element() },
    window: { supabase: { createClient: (url, key, settings) => { calls.push(['createClient', url, key, settings]); return { auth }; } } },
    fetch: async url => { calls.push(['fetch', url]); return { ok: !options.configError, json: async () => ({ supabaseUrl: 'https://example.supabase.co', supabaseKey: 'sb_publishable_test' }) }; }
  };
  vm.runInNewContext(scripts.at(-1), sandbox);
  await tick();
  return {
    nodes, calls, emit: value => authListener('SIGNED_IN', value),
    async submit() { await nodes['#auth-form'].listeners.submit({ preventDefault() {} }); }
  };
}

test('All inline scripts parse and Supabase loads from CDN', () => {
  scripts.forEach(script => new vm.Script(script));
  assert.match(html, /src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2\/dist\/umd\/supabase\.js"/);
});

test('Config uses Vercel public variables and never returns server secrets', () => {
  const result = configRequest({ NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SERVICE_ROLE_KEY: 'private-server-secret' });
  assert.equal(result.code, 200);
  assert.equal(result.body.supabaseKey, 'sb_publishable_test');
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.doesNotMatch(JSON.stringify(result.body), /private-server-secret/);
});

test('Config supports legacy anon keys, rejects missing and privileged keys', () => {
  const jwt = role => `header.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;
  const env = { SUPABASE_URL: 'https://example.supabase.co' };
  assert.equal(configRequest({ ...env, SUPABASE_ANON_KEY: jwt('anon') }).code, 200);
  assert.equal(configRequest(env).code, 503);
  for (const key of ['sb_secret_test', jwt('service_role'), 'invalid']) {
    const result = configRequest({ ...env, SUPABASE_ANON_KEY: key });
    assert.equal(result.code, 503);
    assert.ok(!JSON.stringify(result.body).includes(key));
  }
  assert.equal(configRequest({ ...env, SUPABASE_SERVICE_ROLE_KEY: jwt('service_role') }).code, 503);
  assert.equal(configRequest({}, 'POST').code, 405);
});

test('Login sends email/password and updates header; closes and clears password', async () => {
  const page = await authPage();
  const n = page.nodes;
  assert.equal(n['#login-button'].hidden, false);
  n['#login-button'].listeners.click();
  assert.equal(n['#auth-dialog'].open, true);
  n['#auth-email'].value = ' cook@example.com ';
  n['#auth-password'].value = 'password123';
  await page.submit();
  const request = page.calls.find(call => call[0] === 'login');
  assert.equal(request[1].email, 'cook@example.com');
  assert.equal(request[1].password, 'password123');
  assert.equal(n['#account-email'].textContent, 'cook@example.com');
  assert.equal(n['#login-button'].hidden, true);
  assert.equal(n['#logout-button'].hidden, false);
  assert.equal(n['#auth-dialog'].open, false);
  assert.equal(n['#auth-password'].value, '');
});

test('Signup without session prompts email confirmation and switches to login', async () => {
  const page = await authPage();
  const n = page.nodes;
  n['#login-button'].listeners.click();
  n['#auth-switch'].listeners.click();
  assert.equal(n['#auth-password'].autocomplete, 'new-password');
  n['#auth-email'].value = 'cook@example.com';
  n['#auth-password'].value = 'password123';
  await page.submit();
  assert.ok(page.calls.some(call => call[0] === 'signup'));
  assert.equal(n['#auth-dialog'].open, true);
  assert.equal(n['#auth-title'].textContent, '로그인');
  assert.match(n['#auth-message'].textContent, /이메일 인증/);
  assert.equal(n['#login-button'].hidden, false);
});

test('Signup with session logs in immediately', async () => {
  const page = await authPage({ signupResult: { data: { session }, error: null } });
  page.nodes['#login-button'].listeners.click();
  page.nodes['#auth-switch'].listeners.click();
  await page.submit();
  assert.equal(page.nodes['#auth-dialog'].open, false);
  assert.equal(page.nodes['#account-email'].textContent, session.user.email);
});

test('Login error remains in popup and re-enables controls', async () => {
  const page = await authPage({ loginResult: { data: {}, error: { code: 'invalid_credentials' } } });
  page.nodes['#login-button'].listeners.click();
  await page.submit();
  assert.equal(page.nodes['#auth-dialog'].open, true);
  assert.equal(page.nodes['#auth-message'].dataset.error, 'true');
  assert.equal(page.nodes['#auth-submit'].disabled, false);
  assert.equal(page.nodes['#login-button'].hidden, false);
});

test('Stored session restores header, auth events synchronize it, logout clears it', async () => {
  const page = await authPage({ session });
  assert.equal(page.nodes['#login-button'].hidden, true);
  page.emit(null);
  assert.equal(page.nodes['#login-button'].hidden, false);
  page.emit(session);
  await page.nodes['#logout-button'].listeners.click();
  assert.equal(page.nodes['#login-button'].hidden, false);
  assert.equal(page.nodes['#account-email'].textContent, '');
  assert.equal(page.calls.find(call => call[0] === 'logout')[1].scope, 'local');
});

test('Config failure is visible and does not block popup or allow fake login', async () => {
  const page = await authPage({ configError: true });
  assert.equal(page.nodes['#account-status'].hidden, false);
  page.nodes['#login-button'].listeners.click();
  await page.submit();
  assert.equal(page.nodes['#auth-dialog'].open, true);
  assert.match(page.nodes['#auth-message'].textContent, /환경 변수/);
  assert.equal(page.calls.some(call => call[0] === 'login'), false);
});
