import { describe, expect, it } from "vitest";
import { summarizeFunnel } from "./evaluator.js";
const steps = [
    { type: "event", eventName: "first" },
    { type: "event", eventName: "second" },
    { type: "event", eventName: "third" },
];
const labels = ["First", "Second", "Third"];
const row = (...timestamps) => ({ identity: "user", stepTimestamps: timestamps });
describe("summarizeFunnel", () => {
    it("reports 100% conversion without a drop-off", () => {
        const result = summarizeFunnel(steps.slice(0, 2), labels.slice(0, 2), [row(1, 2), row(3, 4)]);
        expect(result).toMatchObject({ totalUsers: 2, convertedUsers: 2, overallConversion: 100 });
        expect(result.steps[1]).toMatchObject({ conversionFromPrevious: 100, conversionFromStart: 100, droppedBeforeNext: 0 });
    });
    it("keeps step conversion separate from overall conversion", () => {
        const result = summarizeFunnel(steps, labels, [row(1, 2, 3), row(4, 5, null), row(6, 7, null), row(8, null, null)]);
        expect(result.steps[1]).toMatchObject({ users: 3, conversionFromPrevious: 75, conversionFromStart: 75, droppedBeforeNext: 2 });
        expect(result.steps[2]).toMatchObject({ users: 1, conversionFromPrevious: 33.3, conversionFromStart: 25 });
        expect(result.overallConversion).toBe(25);
    });
    it("handles zero users without division errors", () => {
        const result = summarizeFunnel(steps, labels, []);
        expect(result).toMatchObject({ totalUsers: 0, convertedUsers: 0, overallConversion: 0 });
        expect(result.steps.map(step => step.conversionFromPrevious)).toEqual([100, 0, 0]);
    });
    it("computes terminal drop-offs for every transition", () => {
        const result = summarizeFunnel(steps, labels, [row(1, 2, 3), row(4, null, null), row(5, 6, null)]);
        expect(result.steps.map(step => step.droppedBeforeNext)).toEqual([1, 1, 0]);
    });
});
//# sourceMappingURL=evaluator.test.js.map