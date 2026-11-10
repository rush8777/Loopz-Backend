const DAY = 86_400_000;
export interface ResolvedAiRange { since: Date; until: Date; previousSince: Date; previousUntil: Date; timezone: string; label: string; partial: boolean; granularity: "day" | "week" | "month" }

function validTimezone(value: unknown): string {
  if (typeof value !== "string") return "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return value; } catch { return "UTC"; }
}
export function workspaceTimezone(publicConfig: unknown): string {
  const config = publicConfig && typeof publicConfig === "object" ? publicConfig as Record<string, unknown> : {};
  return validTimezone(config.timezone ?? config.analyticsTimezone);
}
function parts(date: Date, timezone: string) {
  const values = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type: string) => values.find(value => value.type === type)?.value ?? "";
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: Number(get("hour")), minute: Number(get("minute")), second: Number(get("second")), weekday: get("weekday") };
}
function zonedMidnight(year: number, month: number, day: number, timezone: string): Date {
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const rendered = parts(new Date(guess), timezone);
    const renderedLocal = Date.UTC(rendered.year, rendered.month - 1, rendered.day, rendered.hour, rendered.minute, rendered.second);
    guess += target - renderedLocal;
  }
  return new Date(guess);
}
function dayStart(date: Date, timezone: string) { const p = parts(date, timezone); return zonedMidnight(p.year, p.month, p.day, timezone); }
function addLocalDays(date: Date, days: number, timezone: string) { const p = parts(date, timezone); const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days)); return zonedMidnight(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), timezone); }
function previous(since: Date, until: Date) { const duration = until.getTime() - since.getTime(); return { previousSince: new Date(since.getTime() - duration), previousUntil: new Date(since.getTime()) }; }

export function resolveAiTimeRange(prompt: string, now = new Date(), timezone = "UTC"): ResolvedAiRange {
  timezone = validTimezone(timezone); const lower = prompt.toLowerCase(); const today = dayStart(now, timezone); let since: Date; let until: Date; let label: string; let partial = false; let granularity: ResolvedAiRange["granularity"] = "day";
  if (/\blast week\b/.test(lower)) { const weekday = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(parts(now, timezone).weekday); const mondayOffset = weekday === 0 ? -6 : 1 - weekday; until = addLocalDays(today, mondayOffset, timezone); since = addLocalDays(until, -7, timezone); label = "Last week"; }
  else if (/\bthis week\b/.test(lower)) { const weekday = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(parts(now, timezone).weekday); since = addLocalDays(today, weekday === 0 ? -6 : 1 - weekday, timezone); until = now; label = "This week to date"; partial = true; }
  else if (/\blast month\b/.test(lower)) { const p = parts(now, timezone); until = zonedMidnight(p.year, p.month, 1, timezone); const previousMonth = new Date(Date.UTC(p.year, p.month - 2, 1)); since = zonedMidnight(previousMonth.getUTCFullYear(), previousMonth.getUTCMonth() + 1, 1, timezone); label = "Last month"; granularity = "day"; }
  else if (/\bthis month\b/.test(lower)) { const p = parts(now, timezone); since = zonedMidnight(p.year, p.month, 1, timezone); until = now; label = "This month to date"; partial = true; }
  else { const match = /\blast\s+(\d{1,3})\s+days?\b/.exec(lower); const days = Math.min(Number(match?.[1] ?? 30), 400); until = now; since = new Date(now.getTime() - days * DAY); label = `Last ${days} days`; partial = true; granularity = days > 120 ? "week" : "day"; }
  const prior = previous(since, until);
  return { since, until, ...prior, timezone, label, partial, granularity };
}
