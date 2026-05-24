const TOAST_DISMISS_DELAY_MS = 3000;
const TOAST_EXIT_DURATION_MS = 320;

const TOAST_ICONS = Object.freeze({
  success:
    "<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M20 7L10.25 16.75L6 12.5\" stroke=\"currentColor\" stroke-width=\"2.25\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
  error:
    "<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><path d=\"M12 8V13\" stroke=\"currentColor\" stroke-width=\"2.25\" stroke-linecap=\"round\"/><path d=\"M12 16.5V16.55\" stroke=\"currentColor\" stroke-width=\"2.25\" stroke-linecap=\"round\"/><path d=\"M10.29 3.86L1.82 18A2 2 0 0 0 3.53 21H20.47A2 2 0 0 0 22.18 18L13.71 3.86A2 2 0 0 0 10.29 3.86Z\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
  info:
    "<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"9\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M12 10V16\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\"/><path d=\"M12 7.6V7.65\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\"/></svg>"
});

function normalizeOptions(typeOrOptions, options) {
  if (typeof typeOrOptions === "object" && typeOrOptions !== null) {
    return {
      type: typeOrOptions.type || "info",
      dismissMs: Number(typeOrOptions.dismissMs) || TOAST_DISMISS_DELAY_MS,
      ariaLive: typeOrOptions.ariaLive || "polite",
      role: typeOrOptions.role || "status",
      container: typeOrOptions.container || document.body
    };
  }

  return {
    type: typeOrOptions || "info",
    dismissMs: Number(options?.dismissMs) || TOAST_DISMISS_DELAY_MS,
    ariaLive: options?.ariaLive || "polite",
    role: options?.role || "status",
    container: options?.container || document.body
  };
}

function removeExistingToast(container) {
  container.querySelector(".toast.app-toast")?.remove();
}

export function showToast(message, typeOrOptions = "info", options = {}) {
  const config = normalizeOptions(typeOrOptions, options);
  const container = config.container || document.body;
  removeExistingToast(container);

  const toast = document.createElement("div");
  toast.className = `toast app-toast ${config.type}`;
  toast.setAttribute("role", config.role);
  toast.setAttribute("aria-live", config.ariaLive);
  toast.setAttribute("aria-atomic", "true");

  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = TOAST_ICONS[config.type] || TOAST_ICONS.info;

  const text = document.createElement("span");
  text.className = "toast-message";
  text.textContent = String(message || "");

  toast.append(icon, text);
  container.appendChild(toast);

  const removeToast = () => toast.remove();

  window.setTimeout(() => {
    toast.classList.add("toast-exit");
    toast.addEventListener("animationend", removeToast, { once: true });
    window.setTimeout(removeToast, TOAST_EXIT_DURATION_MS);
  }, config.dismissMs);

  return toast;
}

