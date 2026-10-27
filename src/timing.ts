export interface PublishSchedule {
  scheduleCycle: string; publishTime: string; weeklyDay: number; timezone: string; anchorDate: string;
}

function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, Number(part.value)]));
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute };
}

export function localDate(now: Date, timezone: string): string {
  const { year, month, day } = localParts(now, timezone);
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timezone: string): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = target;
  for (let i = 0; i < 3; i++) {
    const parts = localParts(new Date(candidate), timezone);
    const rendered = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const delta = target - rendered;
    if (!delta) break;
    candidate += delta;
  }
  return new Date(candidate);
}

export function scheduleMatchesDay(schedule: PublishSchedule, now: Date): boolean {
  const parts = localParts(now, schedule.timezone);
  const calendar = Date.UTC(parts.year, parts.month - 1, parts.day);
  if (schedule.scheduleCycle === 'weekly') return new Date(calendar).getUTCDay() === schedule.weeklyDay;
  const step = schedule.scheduleCycle === 'every2days' ? 2 : schedule.scheduleCycle === 'every3days' ? 3 : 1;
  return Math.round((calendar - Date.parse(`${schedule.anchorDate}T00:00:00Z`)) / 86400000) % step === 0;
}

export function nextPublishTimes(schedule: PublishSchedule, count: number, postsPerRun: number, now = new Date(), reservedTimes: string[] = []): string[] {
  const parts = localParts(now, schedule.timezone);
  const start = Date.UTC(parts.year, parts.month - 1, parts.day);
  const [hour, minute] = schedule.publishTime.split(':').map(Number);
  const times: string[] = [];
  const occupied = new Map<string, number>();
  for (const time of reservedTimes) occupied.set(time, (occupied.get(time) ?? 0) + 1);
  for (let offset = 0; times.length < count && offset < (count + reservedTimes.length) * 7 + 14; offset++) {
    const day = new Date(start + offset * 86400000);
    const candidate = zonedTime(day.getUTCFullYear(), day.getUTCMonth()+1, day.getUTCDate(), hour, minute, schedule.timezone);
    if (candidate.getTime() <= now.getTime() || !scheduleMatchesDay(schedule, candidate)) continue;
    const iso = candidate.toISOString();
    for (let slot = occupied.get(iso) ?? 0; slot < postsPerRun && times.length < count; slot++) times.push(iso);
  }
  return times;
}
