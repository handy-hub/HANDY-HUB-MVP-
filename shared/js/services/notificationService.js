import { getAppContainer } from "../app/container.js";

const {
  services: { notificationService }
} = getAppContainer();

export function sendNotification(notification) {
  return notificationService.send(notification);
}

