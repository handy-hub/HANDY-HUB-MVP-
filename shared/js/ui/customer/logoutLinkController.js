import { getAppContainer } from "../../app/container.js";

const LOGOUT_REDIRECT_URL = "login.html";

const {
  services: { sessionService }
} = getAppContainer();

export function bootstrapLogoutLinkController() {
  const logoutLink = document.getElementById("logout-link");
  if (!logoutLink) return;

  logoutLink.addEventListener("click", async (event) => {
    event.preventDefault();

    const originalText = logoutLink.textContent;
    logoutLink.textContent = "Logging out...";
    logoutLink.style.pointerEvents = "none";

    try {
      await sessionService.logout();
    } catch (error) {
      console.error("Logout failed:", error);
    } finally {
      logoutLink.textContent = originalText;
      logoutLink.style.pointerEvents = "auto";
      window.location.href = LOGOUT_REDIRECT_URL;
    }
  });
}

bootstrapLogoutLinkController();

