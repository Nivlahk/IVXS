"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.debounceLeading = void 0;
function debounceLeading(func, wait) {
    let timeout;
    return function (...args) {
        const context = this;
        const later = function () {
            timeout = undefined;
        };
        const callNow = !timeout;
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
        if (callNow)
            func.apply(context, args);
    };
}
exports.debounceLeading = debounceLeading;
