export function floorUtc(date, granularity) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    if (granularity === "week") {
        const day = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() - day + 1);
    }
    else if (granularity === "month")
        d.setUTCDate(1);
    return d;
}
export function addBucket(date, granularity, count = 1) {
    const d = new Date(date);
    if (granularity === "day")
        d.setUTCDate(d.getUTCDate() + count);
    else if (granularity === "week")
        d.setUTCDate(d.getUTCDate() + 7 * count);
    else
        d.setUTCMonth(d.getUTCMonth() + count);
    return d;
}
export function bucketKey(date, granularity) {
    const start = floorUtc(date, granularity);
    return granularity === "month" ? start.toISOString().slice(0, 7) : start.toISOString().slice(0, 10);
}
export function createBuckets(filters) {
    const since = new Date(filters.since), until = new Date(filters.until), observable = Math.min(until.getTime(), Date.now());
    const result = [];
    for (let start = floorUtc(since, filters.granularity); start.getTime() <= until.getTime() && result.length < 400; start = addBucket(start, filters.granularity)) {
        const end = addBucket(start, filters.granularity);
        const key = bucketKey(start, filters.granularity);
        result.push({ key, label: key, start: new Date(start), end, incomplete: end.getTime() > observable });
    }
    return result;
}
//# sourceMappingURL=buckets.js.map