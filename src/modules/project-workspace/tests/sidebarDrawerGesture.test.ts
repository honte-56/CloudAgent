import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useSidebarDrawerGesture } from '@/modules/project-workspace/hooks/useSidebarDrawerGesture';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(open = false, enabled = true) {
  const root = document.createElement('div');
  root.innerHTML = '<main class="workspace-main-layer"><p>Conversation</p></main><aside class="workspace-drawer"><button class="workspace-drawer-scrim"></button><nav></nav></aside>';
  document.body.append(root);
  const content = root.querySelector('p')!;
  const panel = root.querySelector('nav')!;
  const rootRef = { current: root };
  const panelRef = { current: panel };
  const setOpen = vi.fn();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
  const { rerender, unmount } = renderHook(
    ({ open, enabled }) => useSidebarDrawerGesture({ enabled, open, setOpen, rootRef, panelRef }),
    { initialProps: { open, enabled } },
  );
  const flushFrame = () => act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(0));
  });
  const layer = panel.parentElement!;
  const scrim = root.querySelector<HTMLElement>('.workspace-drawer-scrim')!;
  const main = root.querySelector<HTMLElement>('.workspace-main-layer')!;
  return { root, content, panel, layer, main, scrim, setOpen, frames, flushFrame, rerender, unmount };
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
  const { layer, content, scrim, setOpen, flushFrame } = setup();
  touch(content, 'touchstart', 100, 300, 0);
  const move = touch(content, 'touchmove', 300, 305, 400);
  flushFrame();
  expect(layer.dataset.drawerDragging).toBe('true');
  expect(Number(scrim.style.opacity)).toBeGreaterThan(0.5);
  expect(move.defaultPrevented).toBe(true);
  touch(content, 'touchend', 300, 305, 410, 0);
  expect(setOpen).toHaveBeenCalledWith(true);
  expect(layer.dataset.drawerDragging).toBeUndefined();
});

test.each([[5, 150], [-150, 5]])('vertical scrolling and left swipes keep their gestures (%s, %s)', (dx, dy) => {
  const { layer, content, setOpen } = setup();
  touch(content, 'touchstart', 180, 300, 0);
  const move = touch(content, 'touchmove', 180 + dx, 300 + dy, 400);
  touch(content, 'touchend', 180 + dx, 300 + dy, 410, 0);
  expect(move.defaultPrevented).toBe(false);
  expect(setOpen).not.toHaveBeenCalled();
  expect(layer.dataset.drawerDragging).toBeUndefined();
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
  const { layer, panel, content, setOpen } = setup();
  touch(content, 'touchstart', 100, 300, 0);
  touch(content, 'touchmove', 300, 300, 400);
  touch(content, reason === 'touchcancel' ? 'touchcancel' : 'touchstart', 300, 300, 410, 2);
  touch(content, 'touchend', 300, 300, 420, 0);
  expect(setOpen).not.toHaveBeenCalled();
  expect(layer.dataset.drawerDragging).toBeUndefined();
  expect(panel.style.transform).toBe('translate3d(-100%, 0, 0)');
});

test('desktop does not handle the swipe', () => {
  const { content, setOpen } = setup(false, false);
  touch(content, 'touchstart', 100, 300, 0);
  const move = touch(content, 'touchmove', 300, 300, 400);
  touch(content, 'touchend', 300, 300, 410, 0);
  expect(move.defaultPrevented).toBe(false);
  expect(setOpen).not.toHaveBeenCalled();
});

test('many touchmoves paint only the latest position once per frame without changing the workspace ancestor', () => {
  const { root, content, panel, scrim, frames, flushFrame } = setup();
  const rootChanges = new MutationObserver(() => {});
  rootChanges.observe(root, { attributes: true });
  touch(content, 'touchstart', 100, 300, 0);
  for (let x = 120; x <= 260; x += 20) touch(content, 'touchmove', x, 300, x);
  expect(frames.size).toBe(1);
  expect(panel.style.transform).toBe('translate3d(-100%, 0, 0)');
  flushFrame();
  expect(panel.style.transform).toBe('translate3d(-50%, 0, 0)');
  expect(scrim.style.opacity).toBe('0.5');
  expect(rootChanges.takeRecords()).toHaveLength(0);
  rootChanges.disconnect();
});

test('release starts settling before React commits and discards a queued drag frame', () => {
  const { layer, content, panel, setOpen, frames, flushFrame, rerender } = setup();
  touch(content, 'touchstart', 100, 300, 0);
  touch(content, 'touchmove', 280, 300, 200);
  flushFrame();
  touch(content, 'touchmove', 300, 300, 210);
  expect(frames.size).toBe(1);
  setOpen.mockImplementation(() => {
    expect(layer.dataset.drawerDragging).toBeUndefined();
    expect(layer.dataset.drawerVisible).toBe('true');
    expect(panel.style.transform).toBe('translate3d(0%, 0, 0)');
  });
  touch(content, 'touchend', 300, 300, 220, 0);
  expect(setOpen).toHaveBeenCalledWith(true);
  expect(frames.size).toBe(0);
  flushFrame();
  rerender({ open: true, enabled: true });
  expect(panel.style.transform).toBe('translate3d(0%, 0, 0)');
});

test('catching a closing animation continues from its visible position instead of an endpoint', () => {
  const { layer, panel, scrim, flushFrame, rerender } = setup(true);
  rerender({ open: false, enabled: true });
  const original = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => element === panel
    ? { transform: 'matrix(1, 0, 0, 1, -160, 0)' } as CSSStyleDeclaration
    : original(element));
  touch(panel, 'touchstart', 180, 300, 0);
  touch(panel, 'touchmove', 212, 300, 100);
  flushFrame();
  expect(Number(scrim.style.opacity)).toBeCloseTo(0.6);
  expect(layer.dataset.drawerDragging).toBe('true');
});

test('holding still before releasing does not reuse an old fling velocity', () => {
  const { content, panel, setOpen, flushFrame } = setup();
  touch(content, 'touchstart', 100, 300, 0);
  touch(content, 'touchmove', 160, 300, 20);
  flushFrame();
  touch(content, 'touchend', 160, 300, 500, 0);
  expect(setOpen).not.toHaveBeenCalled();
  expect(panel.style.transform).toBe('translate3d(-100%, 0, 0)');
});

test('button changes still animate and release the main layer after closing', () => {
  vi.useFakeTimers();
  const { layer, panel, main, rerender } = setup();
  rerender({ open: true, enabled: true });
  expect(panel.style.transform).toBe('translate3d(0%, 0, 0)');
  expect(main.style.transform).toBe('translate3d(56px, 0, 0)');
  rerender({ open: false, enabled: true });
  expect(layer.dataset.drawerVisible).toBe('true');
  act(() => vi.advanceTimersByTime(420));
  expect(layer.dataset.drawerVisible).toBeUndefined();
  expect(main.style.transform).toBe('');
});

test('disabling mobile gestures cancels queued frames and removes transient styles', () => {
  const { content, panel, main, layer, frames, rerender, flushFrame } = setup();
  touch(content, 'touchstart', 100, 300, 0);
  touch(content, 'touchmove', 250, 300, 100);
  expect(frames.size).toBe(1);
  rerender({ open: false, enabled: false });
  expect(frames.size).toBe(0);
  flushFrame();
  expect(panel.style.transform).toBe('');
  expect(main.style.transform).toBe('');
  expect(layer.dataset.drawerVisible).toBeUndefined();
});
