import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionExecutionNotice } from '@/shared/ui/SessionExecutionNotice';

const lookup = vi.fn();
const release = vi.fn();
vi.mock('@/shared/api', () => ({ api: { providers: {
  sessionExecution: (...args: unknown[]) => lookup(...args),
  releaseSessionExecution: (...args: unknown[]) => release(...args),
} } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const response = (owner: unknown) => new Response(JSON.stringify({ data: { owner } }));

describe('shared session takeover', () => {
  afterEach(() => { vi.resetAllMocks(); });

  it('opening another view explains ownership without stopping any work', async () => {
    lookup.mockImplementation(async () => response({ id: 'original', kind: 'chat' }));
    render(<SessionExecutionNotice sessionId="a" target="terminal" />);
    expect(await screen.findByText('execution.inChat')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'execution.toTerminal' })).toBeTruthy();
    expect(release).not.toHaveBeenCalled();
  });

  it('waits for confirmed release before reconnecting the terminal', async () => {
    lookup.mockImplementation(async () => response({ id: 'original', kind: 'chat' }));
    let resolve!: (result: Response) => void;
    release.mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
    const onReleased = vi.fn();
    render(<SessionExecutionNotice sessionId="a" target="terminal" onReleased={onReleased} />);
    fireEvent.click(await screen.findByRole('button', { name: 'execution.toTerminal' }));
    expect(release).toHaveBeenCalledWith('a', 'original');
    expect(onReleased).not.toHaveBeenCalled();
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    lookup.mockImplementation(async () => response(null));
    await act(async () => { resolve(new Response(JSON.stringify({ data: { released: true } }))); });
    await waitFor(() => expect(onReleased).toHaveBeenCalledOnce());
  });

  it('failed exit keeps the action available and displays the server reason', async () => {
    lookup.mockImplementation(async () => response({ id: 'terminal-id', kind: 'terminal' }));
    release.mockResolvedValue(new Response(JSON.stringify({ error: 'Process still alive' }), { status: 409 }));
    render(<SessionExecutionNotice sessionId="a" target="chat" />);
    fireEvent.click(await screen.findByRole('button', { name: 'execution.toChat' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Process still alive');
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a late lookup for the previous conversation cannot show a takeover for the new one', async () => {
    let old!: (result: Response) => void;
    lookup.mockImplementation((id: string) => id === 'a'
      ? new Promise<Response>(resolve => { old = resolve; }) : Promise.resolve(response(null)));
    const view = render(<SessionExecutionNotice sessionId="a" target="chat" />);
    view.rerender(<SessionExecutionNotice sessionId="b" target="chat" />);
    await act(async () => { old(response({ id: 'old', kind: 'terminal' })); });
    expect(screen.queryByRole('button')).toBeNull();
  });
});
