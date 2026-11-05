const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]).filter(Boolean);
const userA = { user: { id: 'user-a', email: 'a@example.com' } };
const userB = { user: { id: 'user-b', email: 'b@example.com' } };
const menu = {
  seasonal: [{ month: 11, name: '무' }, { month: 6, name: '감자' }],
  recipes: [
    { id: 1, name: '무 요리', category: '반찬', seasonal: ['무'], months: [11], steps: [] },
    { id: 2, name: '감자 요리', category: '반찬', seasonal: ['감자'], months: [6], steps: [] }
  ]
};
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

async function page(options = {}) {
  const nodes = {}, calls = [], rows = [...(options.rows || [])];
  let session = options.session || null, listener;
  const errors = { read: options.readError, insert: options.insertError, delete: options.deleteError };
  const holds = {};
  class Element {
    constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = {}; this.attrs = {}; this.dataset = {}; this.style = {}; this.classList = { add() {} }; this.value = ''; this.hidden = false; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    setAttribute(k, v) { this.attrs[k] = v; }
    append(...children) { this.children.push(...children); }
    add(child) { this.append(child); }
    replaceChildren(...children) { this.children = children; }
    querySelectorAll() { return this.children; }
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.close?.(); }
    reset() {}
    reportValidity() { return true; }
  }
  function from(table) {
    assert.equal(table, 'favorites');
    const query = { operation: 'read', filters: [], start: 0, end: 499 };
    const builder = {
      select(columns) { query.columns = columns; return this; },
      eq(key, value) { query.filters.push([key, value]); return this; },
      order(key) { query.order = key; return this; },
      range(start, end) { query.start = start; query.end = end; return this; },
      insert(row) { query.operation = 'insert'; query.row = row; return this; },
      delete() { query.operation = 'delete'; return this; },
      then(resolve, reject) {
        const run = async () => {
          calls.push(query);
          if (holds[query.operation]) { const hold = holds[query.operation]; delete holds[query.operation]; await hold.promise; }
          if (errors[query.operation]) return { data: null, error: errors[query.operation] };
          if (query.operation === 'insert') {
            if (rows.some(row => row.user_id === query.row.user_id && row.recipe_id === query.row.recipe_id)) return { error: { code: '23505' } };
            rows.push({ ...query.row });
            return { error: null };
          }
          const matches = row => query.filters.every(([key, value]) => row[key] === value);
          if (query.operation === 'delete') {
            for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i])) rows.splice(i, 1);
            return { error: null };
          }
          return { data: rows.filter(matches).slice(query.start, query.end + 1).map(row => ({ recipe_id: row.recipe_id })), error: null };
        };
        return run().then(resolve, reject);
      }
    };
    return builder;
  }
  const auth = {
    getSession: async () => ({ data: { session }, error: null }),
    onAuthStateChange(fn) { listener = fn; },
    signOut: async () => { session = null; listener('SIGNED_OUT', null); return { error: null }; }
  };
  const context = vm.createContext({
    document: { querySelector: selector => nodes[selector] ||= new Element(), createElement: tag => new Element(tag) },
    window: { supabase: { createClient: () => ({ auth, from }) } },
    Option: function() {}, Date, URL, console, setTimeout, location: { protocol: 'https:' },
    fetch: async url => ({ ok: true, json: async () => url.includes('menu.json') ? menu : { supabaseUrl: 'https://example.supabase.co', supabaseKey: 'sb_publishable_test' } })
  });
  scripts.forEach(script => vm.runInContext(script, context));
  await settle();
  return {
    nodes, calls, rows, errors, holds,
    eval: code => vm.runInContext(code, context),
    open(id) { vm.runInContext(`openRecipe(data.recipes.find(recipe => recipe.id === ${id}))`, context); },
    emit(value) { session = value; listener(value ? 'SIGNED_IN' : 'SIGNED_OUT', value); }
  };
}

test('Anonymous favorite clicks give login guidance without database writes', async () => {
  const p = await page();
  p.open(1);
  await p.nodes['#favorite-toggle'].listeners.click();
  assert.equal(p.nodes['#favorite-message'].textContent, '로그인하면 즐겨찾기를 저장할 수 있어요');
  p.nodes['#favorites-button'].listeners.click();
  assert.equal(p.nodes['#favorites-feedback'].textContent, '로그인하면 즐겨찾기를 저장할 수 있어요');
  assert.equal(p.calls.length, 0);
});

test('Star saves and deletes only the signed-in user recipe; state restores from database', async () => {
  const p = await page({ session: userA, rows: [{ user_id: 'user-b', recipe_id: 1 }] });
  p.open(1);
  assert.equal(p.nodes['#favorite-toggle'].textContent, '☆');
  await p.nodes['#favorite-toggle'].listeners.click();
  assert.equal(p.nodes['#favorite-toggle'].textContent, '★');
  assert.ok(p.rows.some(row => row.user_id === 'user-a' && row.recipe_id === 1));
  await p.eval('loadFavorites()');
  assert.equal(p.nodes['#favorite-toggle'].attrs['aria-pressed'], 'true');
  await p.nodes['#favorite-toggle'].listeners.click();
  assert.equal(p.nodes['#favorite-toggle'].textContent, '☆');
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].user_id, 'user-b');
  assert.deepEqual(p.calls.find(call => call.operation === 'delete').filters.map(pair => Array.from(pair)), [['user_id', 'user-a'], ['recipe_id', 1]]);
});

test('Favorites shows saved recipes across months and deletion updates list immediately', async () => {
  const p = await page({ session: userA, rows: [{ user_id: 'user-a', recipe_id: 2 }] });
  p.nodes['#month'].value = '11';
  p.nodes['#month'].listeners.change();
  assert.equal(p.nodes['#recipes'].children.length, 1);
  p.nodes['#favorites-button'].listeners.click();
  assert.equal(p.nodes['#results-title'].textContent, '내 즐겨찾기');
  assert.equal(p.nodes['#recipes'].children[0].children[1].children[1].children[0].textContent, '감자 요리');
  p.open(2);
  await p.nodes['#favorite-toggle'].listeners.click();
  assert.equal(p.nodes['#recipes'].children.length, 0);
  assert.equal(p.nodes['#notice'].children[0].textContent, '아직 저장한 레시피가 없어요');
  p.nodes['#seasonal-button'].listeners.click();
  assert.equal(p.nodes['#ingredients-panel'].hidden, false);
  assert.equal(p.nodes['#recipes'].children.length, 1);
});

test('Read failures show a retry and never masquerade as an empty favorites list', async () => {
  const p = await page({ session: userA, readError: { code: 'PGRST205' } });
  p.nodes['#favorites-button'].listeners.click();
  assert.match(p.nodes['#notice'].children[1].textContent, /아직 준비되지/);
  p.errors.read = null;
  await p.nodes['#notice'].children[2].listeners.click();
  assert.equal(p.nodes['#notice'].children[0].textContent, '아직 저장한 레시피가 없어요');
});

test('Failed mutations keep the existing star state and can be retried', async () => {
  const p = await page({ session: userA, insertError: { code: '42501' } });
  p.open(1);
  await p.nodes['#favorite-toggle'].listeners.click();
  assert.equal(p.nodes['#favorite-toggle'].textContent, '☆');
  assert.match(p.nodes['#favorite-message'].textContent, /다시 로그인/);
  p.errors.insert = null;
  await p.nodes['#favorite-toggle'].listeners.click();
  p.errors.delete = { code: '42501' };
  await p.nodes['#favorite-toggle'].listeners.click();
  assert.equal(p.nodes['#favorite-toggle'].textContent, '★');
  assert.equal(p.nodes['#favorite-toggle'].disabled, false);
});

test('Duplicate saves from another tab are treated as already saved', async () => {
  const p = await page({ session: userA });
  p.rows.push({ user_id: 'user-a', recipe_id: 1 });
  p.open(1);
  await p.nodes['#favorite-toggle'].listeners.click();
  assert.equal(p.nodes['#favorite-toggle'].textContent, '★');
  assert.equal(p.rows.length, 1);
});

test('Rapid double clicks issue one write, and account changes discard late responses', async () => {
  const p = await page({ session: userA });
  p.open(1);
  const hold = deferred(); p.holds.insert = hold;
  const first = p.nodes['#favorite-toggle'].listeners.click();
  const second = p.nodes['#favorite-toggle'].listeners.click();
  await settle();
  assert.equal(p.calls.filter(call => call.operation === 'insert').length, 1);
  assert.equal(p.nodes['#favorite-toggle'].disabled, true);
  p.emit(userB);
  await settle();
  hold.resolve();
  await Promise.all([first, second]);
  assert.equal(p.nodes['#favorite-toggle'].textContent, '☆');
  assert.equal(p.eval('favoriteUserId'), 'user-b');
  assert.equal(p.eval('favoriteIds.size'), 0);
});

test('Logout clears saved state immediately and ignores in-flight reads', async () => {
  const p = await page({ session: userA, rows: [{ user_id: 'user-a', recipe_id: 1 }] });
  p.open(1);
  p.nodes['#favorites-button'].listeners.click();
  const hold = deferred(); p.holds.read = hold;
  const read = p.eval('loadFavorites()');
  await settle();
  await p.nodes['#logout-button'].listeners.click();
  assert.equal(p.nodes['#favorite-toggle'].textContent, '☆');
  assert.equal(p.eval('favoritesOnly'), false);
  hold.resolve(); await read;
  assert.equal(p.eval('favoriteIds.size'), 0);
});

test('Favorites reads paginate beyond the default row limit', async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => ({ user_id: 'user-a', recipe_id: i + 1 }));
  const p = await page({ session: userA, rows });
  assert.equal(p.eval('favoriteIds.size'), 1001);
  assert.equal(p.calls.filter(call => call.operation === 'read').length, 3);
});
