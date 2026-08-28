export function createFirebaseNotificationService() {
  return {
    async send(notification) {
      if (typeof window === "undefined" || typeof Notification === "undefined") {
        return { delivered: false, reason: "unsupported-environment" };
      }

      if (Notification.permission === "default") {
        await Notification.requestPermission();
      }

      if (Notification.permission !== "granted") {
        return { delivered: false, reason: "permission-denied" };
      }

      const instance = new Notification(notification.title || "HandyHub", {
        body: notification.body || "",
        icon: notification.icon || ""
      });

      return { delivered: true, instance };
    }
  };
}

