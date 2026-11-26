import { expect, it } from "vitest";
import { contextualSkillQuery, rankSkills, type RankedSkill } from "../src/lib/skills/ranking.js";

const workflows = [
  ["invoice-create", "Create an invoice", "Make a new invoice for a customer"],
  ["invoice-edit", "Edit an invoice", "Change invoice details for a customer"],
  ["invoice-download", "Download an invoice", "Save an invoice PDF"],
  ["member-invite", "Invite a team member", "Send an invitation to a teammate by email"],
  ["member-role", "Change a team member role", "Update member permissions and access"],
  ["integration-connect", "Connect an integration", "Link an external app or connector"],
  ["workspace-configure", "Configure a workspace", "Set up workspace settings and preferences"],
  ["notification-update", "Update notification settings", "Adjust email alerts and reminder preferences"],
  ["report-export", "Export a report", "Download analytics data and reporting CSV"],
  ["project-create", "Create a project", "Start a new initiative"],
] as const;

const skills: RankedSkill[] = workflows.map(([id, name, description]) => ({
  id, versionId: id + "-revision", name, similarity: null,
  metadata: { name, description, intentExamples: [description], keywords: [], preconditions: [] },
}));

const supported = [
  ["invoice-create", "How do I create an invoice?", "I need to bill a customer.", "Where can I add a new invoice?", "Can I make an invioce?", "Generate my first invoice."],
  ["invoice-edit", "Edit an invoice", "How do I modify a bill?", "Please change an existing invoice", "Can I update an invice?", "I want to revise invoice details."],
  ["invoice-download", "Download an invoice", "How do I export an invoice?", "Can I save an invoice PDF?", "Retrieve my invoice", "Where can I downlaod my invoice?"],
  ["member-invite", "Invite a team member", "Invite a colleague", "How can I onboard a teammate?", "Send an invitation to a coworker", "Can I invte a team member?"],
  ["member-role", "Change a team member role", "Adjust a teammate’s permissions", "How do I modify a role?", "Edit user access", "Update team member privilges"],
  ["integration-connect", "Connect an integration", "Can I link an app?", "Install a connector", "Connect a plugin", "How do I conenct an integration?"],
  ["workspace-configure", "Configure my workspace", "Can I set up a workspace?", "Customize my organization", "Configure workspace preferences", "Set workspace settings"],
  ["notification-update", "Update notification settings", "Change my email preferences", "Edit notification settings", "Can I adjust my alerts?", "Modify reminder preferences"],
  ["report-export", "Export a report", "Download the analytics report", "Save my reporting data", "Extract an analytics report", "Export a reprt"],
  ["project-create", "Create a project", "Start a new project", "Can I add an initiative?", "How do I make my first project?", "Where do I create a proejct?"],
] as const;

const unsupported = [
  "Can you delete all my invoices?", "Delete an invoice", "Create a recurring invoice", "Edit a PDF template",
  "Disable all notifications", "Remove a workspace", "Download my tax return", "Connect my printer",
  "What time is it?", "Tell me a joke", "What's the weather in Colombo?", "Can you refund a payment?",
  "What is an invoice?", "Define workspace", "What does report export mean?", "Help me with billing",
  "Invoices", "Show me how?", "Help with a member role", "Create a payroll schedule",
];

it("evaluates labeled workflows, abstention, and bounded follow-up context", () => {
  let top1 = 0;
  let top3 = 0;
  let reciprocalRank = 0;
  let examples = 0;
  const misses: string[] = [];
  const queries = supported.flatMap(([label, ...questions]) => questions.map(question => ({ label, question, prior: undefined as string | undefined })));
  queries.push({ label: "invoice-create", question: "Can you show me how?", prior: "How do I create an invoice?" });
  queries.push({ label: "report-export", question: "Walk me through that", prior: "Export the report" });
  for (const { label, question, prior } of queries) {
    const result = rankSkills(contextualSkillQuery(question, prior), skills);
    const index = result.ranked.findIndex(candidate => candidate.id === label);
    if (result.decision.decision === "recommend_skill" && result.decision.skillId === label) top1++;
    else misses.push(question);
    if (index >= 0 && index < 3) top3++;
    if (index >= 0) reciprocalRank += 1 / (index + 1);
    examples++;
  }
  const falseRecommendations = unsupported.filter(query => rankSkills(query, skills).decision.decision === "recommend_skill");
  console.log({ supported: examples, unsupported: unsupported.length, top1, top3, mrr: reciprocalRank / examples, falseRecommendations, misses });
  expect(top1 / examples).toBeGreaterThanOrEqual(0.85);
  expect(top3 / examples).toBeGreaterThanOrEqual(0.95);
  expect(falseRecommendations.length / unsupported.length).toBeLessThan(0.05);
  expect(rankSkills("Help me with billing", skills).decision.decision).toBe("clarify");
  expect(rankSkills("What is an invoice?", skills).decision.decision).toBe("answer_only");
});
