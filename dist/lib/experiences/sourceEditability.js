/** Portable contract mirrored verbatim in the backend; fixtures exercise both implementations. */
export const SOURCE_EDITABILITY = {
    version: 1,
    maxDepth: 8,
    maxNodes: 120,
    containers: ["div", "section", "header"],
    components: ["h1", "h2", "h3", "h4", "p", "span", "label", "a", "ul", "ol", "button", "img", "hr"],
    inline: ["span", "strong", "em", "u", "a", "br", "ul", "ol", "li"],
    operations: ["select", "text", "style", "parent", "child", "move", "resize", "insert", "duplicate", "delete", "image", "action", "undo", "redo"],
    identity: "Each layout has data-movcues-node-id; each atomic component has data-movcues-block-id. A component needs its own node ID unless it is the sole child of a layout wrapper with a node ID. IDs are unique across both namespaces. Inline formatting inside a component has no editing IDs. Containers contain components/layouts, not bare text. Root needs a node ID. Keep surviving IDs; new IDs are distinct from action/question/task IDs.",
    protected: "Survey questions/controls and Checklist tasks/progress/copy/controls are atomic components: preserve their internal functional markup. Checklist root/views/items remain layout containers. Protected components can be styled; their structure, identity, order and parent cannot change through visual structural operations.",
    styles: "Scoped static CSS and responsive @media are preserved. Element style edits follow an existing active responsive declaration; otherwise they affect the base style. Other breakpoints are preserved. Layouts may use flex or grid; sibling drag resizing requires flex. Grid containers retain their tracks; change layout using nested flex containers. No CSS nesting, pseudo-element content, reverse/dense/absolute/fixed layout or reordered visual items.",
};
const idPattern = /^[A-Za-z][A-Za-z0-9_-]{2,63}$/;
const layouts = new Set(SOURCE_EDITABILITY.containers);
const components = new Set(SOURCE_EDITABILITY.components);
const inline = new Set(SOURCE_EDITABILITY.inline);
export function sourceComponentKind(element) {
    const a = element.attrs, role = a["data-movcues-checklist-role"];
    if (a["data-movcues-block-id"] && element.children.some(child => child.attrs["data-movcues-checklist-role"] || child.attrs["data-movcues-survey-controls"]))
        return "protected";
    if (a["data-movcues-question-id"] || "data-movcues-survey-controls" in a || a["data-movcues-checklist-item-id"] || role && !["root", "items"].includes(role))
        return "protected";
    if (a["data-movcues-block-id"] || !layouts.has(element.tag))
        return "component";
    return "layout";
}
export function sourceEditabilityErrors(root, previous, questions) {
    const errors = [], ids = new Set();
    let count = 0;
    const visit = (element, depth, parent) => {
        if (++count > SOURCE_EDITABILITY.maxNodes || depth > SOURCE_EDITABILITY.maxDepth) {
            errors.push("Editable source exceeds 120 components or 8 layout levels.");
            return;
        }
        const kind = sourceComponentKind(element), a = element.attrs;
        for (const key of ["data-movcues-node-id", "data-movcues-block-id"]) {
            if (!(key in a))
                continue;
            if (!idPattern.test(a[key]) || ids.has(a[key]))
                errors.push(`Invalid or duplicate visual ID: ${a[key] || "(empty)"}.`);
            ids.add(a[key]);
        }
        const required = kind === "layout" ? "data-movcues-node-id" : "data-movcues-block-id";
        if (!a[required])
            errors.push(`${element.tag} needs ${required} for live editing.`);
        if (kind !== "layout" && !a["data-movcues-node-id"] && !(parent?.attrs["data-movcues-node-id"] && parent.children.length === 1 && sourceComponentKind(parent) === "layout"))
            errors.push(`Component ${a[required] ?? element.tag} needs a node ID or a dedicated layout wrapper.`);
        if (kind === "layout") {
            if (!layouts.has(element.tag) || element.text.trim())
                errors.push(`Layout ${a[required] ?? element.tag} has ambiguous mixed text; wrap text in a component.`);
            element.children.forEach(child => visit(child, depth + 1, element));
        }
        else if (kind === "component") {
            if (!components.has(element.tag) && !layouts.has(element.tag))
                errors.push(`Unsupported editable component: ${element.tag}.`);
            const checkInline = (child) => {
                if (!inline.has(child.tag) || child.attrs["data-movcues-node-id"] || child.attrs["data-movcues-block-id"] || child.attrs["data-movcues-action-id"])
                    errors.push(`Component ${a[required]} contains a nested component; use a layout container.`);
                child.children.forEach(checkInline);
            };
            element.children.forEach(checkInline);
        }
    };
    if (!root.attrs["data-movcues-node-id"] || sourceComponentKind(root) !== "layout")
        errors.push("The widget root needs a layout node ID, without a block ID.");
    visit(root, 0);
    if (previous?.attrs["data-movcues-node-id"] && root.attrs["data-movcues-node-id"] !== previous.attrs["data-movcues-node-id"])
        errors.push("The surviving widget root must preserve its node ID.");
    // Validate identities inside protected subtrees too, without treating inputs as visual components.
    const all = (element) => { const result = [], pending = [element]; while (pending.length) {
        const next = pending.pop();
        result.push(next);
        pending.push(...next.children.slice().reverse());
    } return result; };
    const visual = all(root).flatMap(element => [element.attrs["data-movcues-node-id"], element.attrs["data-movcues-block-id"]].filter(Boolean));
    const functionalIds = all(root).flatMap(element => [element.attrs["data-movcues-action-id"], element.attrs["data-movcues-question-id"], element.attrs["data-movcues-checklist-item-id"]].filter(Boolean));
    if (visual.some(id => !idPattern.test(id) || functionalIds.includes(id)))
        errors.push("Visual IDs must be valid and distinct from functional action/question/task IDs.");
    for (const element of all(root)) {
        const a = element.attrs, widgetType = root.attrs["data-movcues-widget-type"];
        if (Object.keys(a).some(key => key.startsWith("data-movcues-checklist")) && widgetType !== "checklist")
            errors.push("Checklist markers are only valid in a Checklist.");
        if (Object.keys(a).some(key => key.startsWith("data-movcues-question") || key.startsWith("data-movcues-survey") || key === "data-movcues-option-id") && widgetType !== "survey")
            errors.push("Survey markers are only valid in a Survey.");
        if (a["data-movcues-checklist-role"] && !["root", "title", "description", "items", "item", "progress", "launcher-label", "remaining-count", "completion-title", "completion-description", "completion-acknowledge", "collapse", "dismiss"].includes(a["data-movcues-checklist-role"]))
            errors.push("Unknown protected Checklist role.");
    }
    if (new Set(visual).size !== visual.length)
        errors.push("Source contains duplicate visual IDs, including protected components.");
    if (questions) {
        const elements = all(root), groups = elements.filter(element => element.attrs["data-movcues-question-id"]);
        if (groups.length !== questions.length)
            errors.push("Survey questions must match the canonical question identities exactly.");
        for (const question of questions) {
            const group = groups.find(element => element.attrs["data-movcues-question-id"] === question.id);
            if (!group)
                continue;
            const descendants = all(group);
            if (question.type === "short_text" || question.type === "long_text") {
                const inputs = descendants.filter(element => "data-movcues-question-input" in element.attrs);
                if (inputs.length !== 1 || inputs[0].tag !== (question.type === "short_text" ? "input" : "textarea") || inputs[0].attrs.maxlength !== String(question.maxLength ?? 10000) || Boolean(inputs[0].attrs["aria-required"] === "true") !== Boolean(question.required))
                    errors.push(`Question ${question.id} must preserve its canonical text input, limit and required state.`);
            }
            else {
                const expected = question.type === "nps" ? Array.from({ length: 11 }, (_, index) => String(index)) : question.type === "rating" && question.min !== undefined && question.max !== undefined ? Array.from({ length: question.max - question.min + 1 }, (_, index) => String(index + question.min)) : question.options?.map(option => option.id);
                const options = descendants.filter(element => element.attrs["data-movcues-option-id"]);
                if (expected && (options.length !== expected.length || expected.some(id => options.filter(option => option.tag === "button" && option.attrs["data-movcues-option-id"] === id).length !== 1)))
                    errors.push(`Question ${question.id} must preserve its canonical answer options.`);
            }
        }
        for (const option of elements.filter(element => element.attrs["data-movcues-option-id"]))
            if (!groups.some(group => all(group).includes(option)))
                errors.push("Survey options must remain inside a canonical question.");
    }
    if (previous) {
        const next = all(root), before = all(previous);
        const functionalKeys = ["data-movcues-question-id", "data-movcues-question-type", "data-movcues-question-input", "data-movcues-option-id", "data-movcues-survey-action", "data-movcues-survey-controls", "data-movcues-checklist-item-id", "data-movcues-checklist-role", "data-movcues-checklist-item-role", "data-movcues-checklist-view", "type", "maxlength"];
        const signature = (element) => ({ tag: element.tag, attrs: Object.fromEntries(functionalKeys.filter(key => key in element.attrs).map(key => [key, element.attrs[key]])), children: element.children.map(signature) });
        for (const element of before) {
            const a = element.attrs;
            const marker = ["data-movcues-question-id", "data-movcues-checklist-item-id", "data-movcues-survey-controls"].find(key => key in a);
            if (marker) {
                const matches = next.filter(value => value.attrs[marker] === a[marker]);
                if (matches.length !== 1 || JSON.stringify(signature(matches[0])) !== JSON.stringify(signature(element)))
                    errors.push(`Protected ${marker} ${a[marker]} changed its functional structure.`);
            }
            // Stable canonical content roles and HTML IDs identify surviving elements independently of layout.
            const identity = a.id ? "id" : a["data-movcues-content"] ? "data-movcues-content" : marker;
            if (!identity)
                continue;
            const matches = next.filter(value => value.attrs[identity] === a[identity]);
            if (matches.length !== 1)
                continue;
            for (const key of ["data-movcues-node-id", "data-movcues-block-id"])
                if (a[key] && matches[0].attrs[key] !== a[key])
                    errors.push(`Surviving ${identity} ${a[identity]} must preserve ${key}=${a[key]}.`);
        }
    }
    return [...new Set(errors)];
}
//# sourceMappingURL=sourceEditability.js.map