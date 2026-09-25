import crypto from "node:crypto";
import type { ChecklistExperienceDefinition, ChecklistItem, WidgetBuilderState } from "./types.js";

export type ChecklistPreset = "default" | "minimal" | "soft" | "compact";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));

export function checklistItemId(): string {
  return `item_${crypto.randomBytes(8).toString("hex")}`;
}

export function checklistItemMarkup(item: ChecklistItem): string {
  return `<button type="button" class="movecues-checklist__item" data-movecues-checklist-item-id="${escapeHtml(item.id)}" data-movecues-checklist-role="item"><span class="movecues-checklist__state" data-movecues-checklist-item-role="state">✓</span><span class="movecues-checklist__copy"><span class="movecues-checklist__item-title" data-movecues-checklist-item-role="title">${escapeHtml(item.title)}</span><span class="movecues-checklist__item-description" data-movecues-checklist-item-role="description">${escapeHtml(item.description ?? "")}</span></span></button>`;
}

export function checklistBuilder(definition: Pick<ChecklistExperienceDefinition, "title" | "description" | "items" | "completionMessage">, preset: ChecklistPreset = "default"): WidgetBuilderState {
  const compact = preset === "compact";
  const soft = preset === "soft";
  const minimal = preset === "minimal";
  const html = `<section class="movecues-widget movecues-checklist movecues-checklist--${preset}" data-movecues-widget-type="checklist" data-movecues-checklist-role="root"><div class="movecues-checklist__expanded" data-movecues-checklist-view="expanded"><header class="movecues-checklist__header" data-movecues-checklist-role="header"><div><h2 class="movecues-checklist__title" data-movecues-checklist-role="title">${escapeHtml(definition.title)}</h2><p class="movecues-checklist__description" data-movecues-checklist-role="description">${escapeHtml(definition.description ?? "")}</p></div><button type="button" class="movecues-checklist__collapse" data-movecues-checklist-role="collapse" aria-label="Collapse checklist">−</button></header><div class="movecues-checklist__progress" data-movecues-checklist-role="progress"></div><div class="movecues-checklist__items" data-movecues-checklist-role="items">${definition.items.map(checklistItemMarkup).join("")}</div></div><button type="button" class="movecues-checklist__launcher" data-movecues-checklist-view="launcher"><span data-movecues-checklist-role="launcher-label">${escapeHtml(definition.title)}</span><span class="movecues-checklist__count" data-movecues-checklist-role="remaining-count"></span></button><div class="movecues-checklist__completion" data-movecues-checklist-view="completion"><h2 data-movecues-checklist-role="completion-title">${escapeHtml(definition.completionMessage.title)}</h2><p data-movecues-checklist-role="completion-description">${escapeHtml(definition.completionMessage.description ?? "")}</p><button type="button" data-movecues-checklist-role="completion-acknowledge">${escapeHtml(definition.completionMessage.acknowledgeLabel)}</button></div></section>`;
  const css = `.movecues-widget{box-sizing:border-box;width:${compact ? "320px" : "360px"};max-width:calc(100vw - 32px);padding:${compact ? "16px" : "22px"};background:${soft ? "#f8fafc" : "#fff"};color:#111827;border:${minimal ? "0" : "1px solid rgba(15,23,42,.1)"};border-radius:${minimal ? "8px" : "16px"};font-family:ui-sans-serif,system-ui,sans-serif;box-shadow:${minimal ? "0 8px 24px rgba(15,23,42,.12)" : "0 24px 70px rgba(15,23,42,.2)"}}.movecues-widget [data-movecues-checklist-view]{display:none}.movecues-widget [data-movecues-checklist-view].is-active{display:block}.movecues-widget .movecues-checklist__header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.movecues-widget .movecues-checklist__title{margin:0;font-size:${compact ? "17px" : "20px"};line-height:1.25}.movecues-widget .movecues-checklist__description{margin:6px 0 0;color:#64748b;font-size:13px;line-height:1.45}.movecues-widget .movecues-checklist__collapse{border:0;background:transparent;color:#64748b;font-size:20px;cursor:pointer}.movecues-widget .movecues-checklist__progress{margin:16px 0 10px;color:#64748b;font-size:12px}.movecues-widget .movecues-checklist__items{display:grid;gap:8px}.movecues-widget .movecues-checklist__item{display:flex;width:100%;align-items:flex-start;gap:10px;padding:${compact ? "9px" : "12px"};border:0;border-radius:10px;background:${soft ? "#fff" : "#f8fafc"};color:inherit;text-align:left;cursor:pointer}.movecues-widget .movecues-checklist__item[data-state=locked]{opacity:.5;cursor:not-allowed}.movecues-widget .movecues-checklist__item[data-state=completed] .movecues-checklist__state{background:#16a34a;color:#fff}.movecues-widget .movecues-checklist__state{display:grid;width:22px;height:22px;flex:0 0 22px;place-items:center;border:1px solid #cbd5e1;border-radius:99px;color:transparent;font-size:12px}.movecues-widget .movecues-checklist__copy{display:grid;gap:3px}.movecues-widget .movecues-checklist__item-title{font-size:14px;font-weight:700}.movecues-widget .movecues-checklist__item-description{color:#64748b;font-size:12px}.movecues-widget .movecues-checklist__launcher{width:100%;border:0;border-radius:12px;padding:12px 16px;background:#2563eb;color:#fff;font-weight:700;cursor:pointer}.movecues-widget .movecues-checklist__count{margin-left:8px;opacity:.8}.movecues-widget .movecues-checklist__completion h2{margin:0 0 8px;font-size:20px}.movecues-widget .movecues-checklist__completion p{margin:0 0 16px;color:#64748b}.movecues-widget .movecues-checklist__completion button{border:0;border-radius:9px;padding:10px 16px;background:#2563eb;color:#fff;font-weight:700;cursor:pointer}`;
  return { version: 1, projectData: {}, html, css };
}

export function initialChecklistDefinition(preset: ChecklistPreset = "default"): ChecklistExperienceDefinition {
  const item: ChecklistItem = { id: checklistItemId(), title: "Complete your first task", description: "Connect this task to a Guide, destination, or Segment.", action: { type: "none" }, completion: { type: "item_clicked" } };
  const core = {
    title: "Getting started",
    description: "A few quick steps to help you get value from the product.",
    items: [item],
    behavior: { position: "bottom-right" as const, order: "any" as const, dismissible: true, initialState: "expanded" as const, showRemainingCount: true },
    completionMessage: { title: "You're all set!", description: "You completed every onboarding task.", acknowledgeLabel: "Done" },
    targeting: { pageRules: [], audience: { type: "all" as const }, priority: 0 },
  };
  return { ...core, builder: checklistBuilder(core, preset) };
}
