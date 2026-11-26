import type { SkillMetadata, SkillRecommendation } from "./contracts.js";

const groups = {
  create: ["create", "make", "add", "start", "generate", "new", "open"],
  edit: ["edit", "modify", "change", "update", "adjust", "revise"],
  download: ["download", "save", "export", "extract", "retrieve"],
  invite: ["invite", "onboard", "invitation"],
  connect: ["connect", "link", "integrate", "install", "attach"],
  configure: ["configure", "setup", "customize", "set"],
  delete: ["delete", "remove", "erase", "purge", "destroy", "clear", "wipe"],
  cancel: ["cancel", "void", "disable", "disconnect", "revoke"],
};
const equivalents = Object.fromEntries(Object.entries(groups).flatMap(([action, aliases]) => aliases.map(alias => [alias, action])));
const terms: Record<string, string> = {
  billings: "invoice", billing: "invoice", bill: "invoice", billed: "invoice", charge: "invoice", invoicing: "invoice",
  teammate: "member", colleague: "member", user: "member", coworker: "member",
  privilege: "role", permission: "role", access: "role",
  alert: "notification", email: "notification", reminder: "notification",
  app: "integration", connector: "integration", plugin: "integration",
  analytics: "report", dashboard: "report", reporting: "report",
  preferences: "settings", preference: "settings", organisation: "workspace", organization: "workspace",
  initiative: "project", recurring: "recurring", scheduled: "recurring", repeat: "recurring", collaborator: "member", integration: "integration",
  workspace: "workspace", project: "project", report: "report", member: "member", invoice: "invoice", notification: "notification", role: "role",
};
const ignored = new Set("i me my our we the a an your this that them it is are am please help do how want need would can could should show where to for with you in of on from and by into first get customer client account up me again some someone people their existing current one already details way product".split(" "));
const known = [...new Set([...Object.keys(equivalents), ...Object.keys(terms), ...Object.values(terms)])];
const actionNames = new Set(Object.keys(groups));
const auxiliary = new Set(["settings", "team"]);

function sameWithTypo(word: string, candidate: string) {
  if (Math.abs(word.length - candidate.length) > 1 || word.length < 5) return false;
  let index = 0;
  while (index < Math.min(word.length, candidate.length) && word[index] === candidate[index]) index++;
  return word.length === candidate.length
    ? word.slice(index + 1) === candidate.slice(index + 1)
      || word[index] === candidate[index + 1] && word[index + 1] === candidate[index] && word.slice(index + 2) === candidate.slice(index + 2)
    : word.length > candidate.length ? word.slice(index + 1) === candidate.slice(index) : word.slice(index) === candidate.slice(index + 1);
}

function normalize(text: string) {
  const result = new Set<string>();
  text = text.replace(/\bset up\b/gi, "setup").replace(/\bnew\b(?=\s+(?:alerts?|emails?|roles?|settings?)\b)/gi, "");
  if (/\b(?:bill|charge|invoice)\s+(?:(?:a|the|my|our)\s+)?(?:customer|client)\b/i.test(text)) result.add("create");
  for (let word of (text.toLowerCase().match(/[a-z\d]+/g) ?? []).slice(0, 90)) {
    if (ignored.has(word)) continue;
    if (word.length > 4 && word.endsWith("s") && !terms[word] && word !== "settings") word = word.slice(0, -1);
    if (!terms[word] && !equivalents[word] && !known.includes(word)) {
      const matches = known.filter(candidate => sameWithTypo(word, candidate)).map(candidate => terms[candidate] ?? equivalents[candidate] ?? candidate);
      if (matches.length && new Set(matches).size === 1) word = matches[0];
    }
    result.add(terms[word] ?? equivalents[word] ?? word);
  }
  return result;
}

export function contextualSkillQuery(question: string, previous?: string) {
  return previous && /^(?:yes[, ]+)?(?:can you |could you |please )?(?:show me(?: how)?|walk me through (?:it|that)|how do i do (?:it|that)|what(?:'s| is) next)[?.! ]*$/i.test(question.trim())
    ? previous.slice(0, 1000) : question;
}

export type RankedSkill = {
  id: string; versionId: string; name: string; metadata: SkillMetadata;
  similarity: number | null;
};

export function rankSkills(question: string, candidates: RankedSkill[], max = 5, threshold = 0.57) {
  const query = normalize(question);
  const actions = [...query].filter(term => actionNames.has(term));
  const objects = [...query].filter(term => !actionNames.has(term) && !auxiliary.has(term));
  const informational = /^\s*(?:what (?:is|are|does)|define|why (?:is|are|do|does))\b/i.test(question);
  const unsafe = /\b(bulk|mass|every|all)\b/i.test(question) && actions.some(action => action === "delete" || action === "cancel");
  if (informational || unsafe) return { ranked: [], decision: { schemaVersion: 1, decision: informational ? "answer_only" : "insufficient_evidence" } as SkillRecommendation };

  const scored = candidates.flatMap(candidate => {
    const name = normalize(candidate.name);
    const profile = normalize([candidate.name, candidate.metadata.description, ...candidate.metadata.keywords, ...candidate.metadata.intentExamples].join(" "));
    const candidateAction = [...name].find(term => actionNames.has(term));
    if (actions.length && (!candidateAction || !actions.includes(candidateAction))) return [];
    if (candidateAction && ["delete", "cancel"].includes(candidateAction) && !actions.includes(candidateAction)) return [];
    if (query.has("recurring") !== name.has("recurring") && (query.has("recurring") || actions.length)) return [];
    const matches = objects.filter(term => profile.has(term));
    const similarity = candidate.similarity ?? 0;
    if (!objects.length || !matches.length && similarity < 0.74) return [];
    const lexical = matches.length / objects.length;
    // Keep exact role, task and qualifier matches ahead of related descriptions.
    const title = objects.filter(term => name.has(term)).length / objects.length;
    const score = 0.55 * lexical + 0.25 * title + 0.15 * Math.max(0, similarity) + (actions.length ? 0.15 : 0);
    return [{ ...candidate, score }];
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const ranked = scored.slice(0, max);
  const [best, next] = ranked;
  let decision: SkillRecommendation = { schemaVersion: 1, decision: "insufficient_evidence" };
  if (best && (actions.length !== 1 || next && best.score - next.score < 0.09)) decision = { schemaVersion: 1, decision: "clarify" };
  else if (best && best.score >= threshold && actions.length === 1) decision = {
    schemaVersion: 1, decision: "recommend_skill", skillId: best.id, skillVersionId: best.versionId, reason: "The requested workflow matches the approved skill metadata.",
  };
  return { ranked, decision };
}
