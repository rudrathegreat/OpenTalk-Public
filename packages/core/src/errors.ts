export class AppError extends Error {
  constructor(readonly code: string) { super('Sorry, not available'); this.name = 'AppError'; }
}
export function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw new AppError('canceled'); }
export function errorCode(error: unknown): string { return error instanceof AppError ? error.code : 'operation_failed'; }
