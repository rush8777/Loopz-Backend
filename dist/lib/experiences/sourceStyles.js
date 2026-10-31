import postcss from "postcss";
/** Shared source CSS restrictions, mirrored verbatim by the backend. */
export function sourceEditingCssErrors(css) {
    let root;
    try {
        root = postcss.parse(css);
    }
    catch {
        return ["Source CSS is not valid CSS."];
    }
    const errors = [];
    root.walkAtRules(rule => { if (rule.name.toLowerCase() !== "media")
        errors.push(`CSS @${rule.name} is not supported.`); });
    root.walkRules(rule => {
        if (rule.parent?.type === "rule")
            errors.push("Nested CSS rules are not supported by live editing.");
        for (const selector of rule.selectors) {
            if (!/^\.movcues-widget(?:\b|[.#:[>+~\s])/.test(selector.trim()))
                errors.push(`Unscoped selector: ${selector}`);
            if (selector.includes("::") || /#[A-Za-z_-]/.test(selector) || selector.length > 512)
                errors.push(`Editable selectors must use classes/attributes, without IDs or pseudo-elements: ${selector}`);
        }
    });
    root.walkDecls(decl => {
        const property = decl.prop.toLowerCase(), value = decl.value.trim().toLowerCase();
        if (/^(?:animation|transition)(?:-|$)/.test(property) || ["behavior", "-moz-binding"].includes(property) || /expression\s*\(|javascript\s*:|url\s*\(/i.test(value))
            errors.push(`Unsafe or unsupported CSS declaration: ${property}`);
        if (property === "position" && /^(absolute|fixed)$/.test(value) || property === "order" && value !== "0" || property === "flex-direction" && value.includes("reverse") || property === "grid-auto-flow" && value.includes("dense") || property === "content" && !["normal", "none"].includes(value))
            errors.push(`Visual ordering/layout is not supported for live editing: ${property}: ${value}`);
    });
    return [...new Set(errors)];
}
//# sourceMappingURL=sourceStyles.js.map