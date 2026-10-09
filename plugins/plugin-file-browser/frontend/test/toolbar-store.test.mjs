import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolbarStore } from '../src/toolbar-store.ts';

test('top toolbar follows the last visible pane without mixing sessions', () => {
  const store = createToolbarStore();
  const left = { cwd: '/left' }, right = { cwd: '/right' }, other = { cwd: '/other' };
  store.set('tab-1', 'p0', left, true);
  store.set('tab-1', 'p1', right, true);
  store.set('tab-2', 'p0', other, true);
  assert.equal(store.get('tab-1'), left);
  store.claim('tab-1', 'p1');
  assert.equal(store.get('tab-1'), right);
  assert.equal(store.get('tab-2'), other);
  store.set('tab-1', 'p1', right, false);
  assert.equal(store.get('tab-1'), left);
  store.remove('tab-1', 'p0');
  assert.equal(store.get('tab-1'), null);
  store.set('tab-1', 'p1', right, true);
  assert.equal(store.get('tab-1'), right);
});

test('navigation snapshots remain stable and listeners clean up', () => {
  const store = createToolbarStore();
  let notifications = 0;
  const off = store.subscribe(() => notifications++);
  const controller = { cwd: '/a' };
  store.set('tab-1', 'p0', controller, true);
  assert.equal(store.get('tab-1'), store.get('tab-1'));
  store.claim('tab-1', 'p0');
  assert.equal(notifications, 2);
  off();
  store.remove('tab-1', 'p0');
  assert.equal(notifications, 2);
  assert.equal(store.get('tab-1'), null);
});
