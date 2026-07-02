/**
 * escapeHtml.js — Single source of truth for HTML escaping.
 *
 * Prevents XSS when interpolating user-controlled strings into innerHTML.
 * Use this instead of the inline _esc()/_escTag() helpers duplicated across
 * the codebase. Import the named export `esc` everywhere.
 *
 * This covers the five characters that are dangerous in HTML contexts.
 * Do NOT use for attribute values without quotes — always quote attributes.
 */

/** HTML-escape a value for safe innerHTML interpolation. */
export function esc(value) {
    return String(value == null ? '' : value)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#x27;');
}

/**
 * Tag function for template literals — escapes all interpolated values.
 *
 * Usage:
 *   el.innerHTML = html`<p class="${cls}">${userInput}</p>`;
 */
export function html(strings, ...values) {
    return strings.reduce((acc, str, i) => {
        const val = i < values.length ? esc(values[i]) : '';
        return acc + str + val;
    }, '');
}
