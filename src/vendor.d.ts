declare module 'node-cron' {
  export function schedule(expression: string, task: () => void, options?: { timezone?: string }): unknown;
}
