import { describe, expect, it, vi } from 'vitest';
const jobs = vi.hoisted(() => ({ callbacks: [] as (() => unknown)[], stop: vi.fn(), scan: vi.fn(), select: vi.fn(), publish: vi.fn() }));
vi.mock('node-cron', () => ({ default: { schedule: vi.fn((_schedule, callback) => { jobs.callbacks.push(callback); return { stop: jobs.stop }; }) } }));
vi.mock('../src/scanner.js', () => ({ scanPhotos: jobs.scan }));
vi.mock('../src/selector.js', () => ({ selectAndQueue: jobs.select }));
vi.mock('../src/publisher.js', () => ({ publishPending: jobs.publish }));
import { startScheduler, reschedule } from '../src/scheduler.js';
import cron from 'node-cron';

describe('manual handoff scheduling', () => {
  it('only schedules scoring and selection, including after configuration changes', async () => {
    startScheduler();
    expect(cron.schedule).toHaveBeenCalledTimes(2);
    jobs.callbacks[0](); await vi.waitFor(() => expect(jobs.scan).toHaveBeenCalledTimes(1));
    jobs.callbacks[1](); await vi.waitFor(() => expect(jobs.select).toHaveBeenCalledTimes(1));
    reschedule();
    expect(jobs.stop).toHaveBeenCalledTimes(2);
    expect(cron.schedule).toHaveBeenCalledTimes(4);
    expect(jobs.publish).not.toHaveBeenCalled();
  });
});
