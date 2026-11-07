import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useSidebarDrawerGesture } from '@/modules/project-workspace/hooks/useSidebarDrawerGesture';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function setup(open = false, enabled = true) {
  const root = document.createElement('div');
  root.innerHTML = '<main class="workspace-main-layer"><p>Conversation</p></main><aside><nav></nav></aside>';
  document.body.append(root);
  const content = root.querySelector('p')!;
  const panel = root.querySelector('nav')!;
  const rootRef = { current: root };
  const panelRef = { current: panel };
  const setOpen = vi.fn();
  renderHook(() => useSidebarDrawerGesture({ enabled, open, setOpen, rootRef, panelRef }));
  return { root, content, panel, setOpen };
}

function touch(target: Element, type: string, x: number, y: number, time: number, count = 1) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: Array.from({ length: count }, () => ({ clientX: x, clientY: y })) },
    timeStamp: { value: time },
  });
  act(() => { target.dispatchEvent(event); });
  return event;
}

test('a right swipe from the middle of the conversation opens the drawer', () => {
  const { root, content, setOpen } = setup();
  touch(content, 'touchstart', 100, 300, 0);
  const move = touch(content, 'touchmove', 300, 305, 400);
  expect(root.dataset.drawerDragging).toBe('true');
  expect(Number(root.style.getPropertyValue('--drawer-progress'))).toBeGreaterThan(0.5);
  expect(move.defaultPrevented).toBe(true);
  touch(content, 'touchend', 300, 305, 410, 0);
  expect(setOpen).toHaveBeenCalledWith(true);
  expect(root.dataset.drawerDragging).toBeUndefined();
});

test.each([[5, 150], [-150, 5]])('vertical scrolling and left swipes keep their gestures (%s, %s)', (dx, dy) => {
  const { root, content, setOpen } = setup();
  touch(content, 'touchstart', 180, 300, 0);
  const move = touch(content, 'touchmove', 180 + dx, 300 + dy, 400);
  touch(content, 'touchend', 180 + dx, 300 + dy, 410, 0);
  expect(move.defaultPrevented).toBe(false);
  expect(setOpen).not.toHaveBeenCalled();
  expect(root.dataset.drawerDragging).toBeUndefined();
});

test.each(['textarea', 'input', 'button', 'a', '[role="dialog"]', '.cm-editor', '.xterm'])('preserves gestures on %s', (selector) => {
  const { content, setOpen } = setup();
  const target = document.createElement(selector.startsWith('.') || selector.startsWith('[') ? 'div' : selector);
  if (selector.startsWith('.')) target.className = selector.slice(1);
  if (selector.startsWith('[')) target.setAttribute('role', 'dialog');
  content.append(target);
  touch(target, 'touchstart', 100, 300, 0);
  const move = touch(target, 'touchmove', 300, 300, 400);
  touch(target, 'touchend', 300, 300, 410, 0);
  expect(move.defaultPrevented).toBe(false);
  expect(setOpen).not.toHaveBeenCalled();
});

test('horizontal scrolling inside a code block does not open the drawer', () => {
  const { content, setOpen } = setup();
  content.style.overflowX = 'auto';
  Object.defineProperties(content, { scrollWidth: { value: 800 }, clientWidth: { value: 300 } });
  const code = document.createElement('code');
  content.append(code);
  touch(code, 'touchstart', 100, 300, 0);
  const move = touch(code, 'touchmove', 300, 300, 400);
  touch(code, 'touchend', 300, 300, 410, 0);
  expect(move.defaultPrevented).toBe(false);
  expect(setOpen).not.toHaveBeenCalled();
});

test('an overlay outside the main content cannot open the drawer underneath it', () => {
  const { root, setOpen } = setup();
  const overlay = document.createElement('div');
  root.append(overlay);
  touch(overlay, 'touchstart', 100, 300, 0);
  touch(overlay, 'touchmove', 300, 300, 400);
  touch(overlay, 'touchend', 300, 300, 410, 0);
  expect(setOpen).not.toHaveBeenCalled();
});

test('left swiping an open panel still closes it', () => {
  const { panel, setOpen } = setup(true);
  touch(panel, 'touchstart', 280, 300, 0);
  touch(panel, 'touchmove', 40, 300, 400);
  touch(panel, 'touchend', 40, 300, 410, 0);
  expect(setOpen).toHaveBeenCalledWith(false);
});

test.each(['touchcancel', 'second finger'])('%s cancels a drag without opening the drawer', (reason) => {
  const { root, content, setOpen } = setup();
  touch(content, 'touchstart', 100, 300, 0);
  touch(content, 'touchmove', 300, 300, 400);
  touch(content, reason === 'touchcancel' ? 'touchcancel' : 'touchstart', 300, 300, 410, 2);
  touch(content, 'touchend', 300, 300, 420, 0);
  expect(setOpen).not.toHaveBeenCalled();
  expect(root.dataset.drawerDragging).toBeUndefined();
  expect(root.style.getPropertyValue('--drawer-progress')).toBe('0');
});

test('desktop does not handle the swipe', () => {
  const { content, setOpen } = setup(false, false);
  touch(content, 'touchstart', 100, 300, 0);
  const move = touch(content, 'touchmove', 300, 300, 400);
  touch(content, 'touchend', 300, 300, 410, 0);
  expect(move.defaultPrevented).toBe(false);
  expect(setOpen).not.toHaveBeenCalled();
});
