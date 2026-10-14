import { AppError } from './errors';
export const UI_ORIGIN = 'opentalk://app';
const OVERLAY_IPC_CHANNELS = new Set(['snapshot', 'cancel-session', 'recording-visible', 'copy-recovery', 'overlay-pointer-input', 'command-mode', 'meeting-pause', 'meeting-resume', 'meeting-bookmark', 'meeting-stop']);
const ASSISTANT_IPC_CHANNELS = new Set(['snapshot', 'cancel-session', 'assistant-start', 'assistant-stop', 'assistant-accept', 'assistant-result', 'assistant-copy']);
export function overlayIpcAllowed(channel: string): boolean { return OVERLAY_IPC_CHANNELS.has(channel); }
export function assistantIpcAllowed(channel: string): boolean { return ASSISTANT_IPC_CHANNELS.has(channel); }
export function trustedFrame(senderId: number, expectedId: number, frameUrl: string, isMainFrame: boolean): void {
  if (senderId !== expectedId || !isMainFrame) throw new AppError('ipc_sender');
  const url = new URL(frameUrl);
  if (url.protocol !== 'opentalk:' || url.hostname !== 'app' || url.username || url.password || url.pathname !== '/index.html') throw new AppError('ipc_origin');
}
export function uiPath(requestUrl: string): string {
  const url = new URL(requestUrl);
  if (url.protocol !== 'opentalk:' || url.hostname !== 'app' || url.username || url.password || url.port) throw new AppError('protocol_origin');
  const path = decodeURIComponent(url.pathname);
  if (path.includes('..') || path.includes('\\') || path.includes('\0') || !/^\/(index\.html|assets\/[a-zA-Z0-9._-]+)$/.test(path)) throw new AppError('protocol_path');
  return path.slice(1);
}
