import "../../../shared/js/utils/global-app.js";
import { getAppContainer } from "../../../shared/js/app/container.js";
import {
  firebaseAuth,
  firebaseDb,
  firebaseStorage
} from "../../../shared/js/backend/providers/firebase/firebaseConfig.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
  doc,
  onSnapshot,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

const LOGIN_URL = "login.html";
const CUSTOMERS_COLLECTION = "customers";
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_AVATAR =
  "https://ui-avatars.com/api/?background=e03030&color=fff&size=128&name=User";

const TOAST_ICONS = Object.freeze({
  success:
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20 7L10.25 16.75L6 12.5" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  error:
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 8V13" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"/><path d="M12 16.5V16.55" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"/><path d="M10.29 3.86L1.82 18A2 2 0 0 0 3.53 21H20.47A2 2 0 0 0 22.18 18L13.71 3.86A2 2 0 0 0 10.29 3.86Z" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  info:
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 10V16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M12 7.6V7.65" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>'
});

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(message, type = "info") {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.setAttribute("role", "alert");
  toast.setAttribute("aria-live", "polite");

  const iconEl = document.createElement("span");
  iconEl.className = "toast-icon";
  iconEl.setAttribute("aria-hidden", "true");
  iconEl.innerHTML = TOAST_ICONS[type] || TOAST_ICONS.info;

  const msgEl = document.createElement("span");
  msgEl.className = "toast-message";
  msgEl.textContent = message;

  toast.appendChild(iconEl);
  toast.appendChild(msgEl);
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("toast-exit");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 320);
  }, 3000);
}

// ─── Greeting ─────────────────────────────────────────────────────────────────
function buildGreeting(name) {
  const hour = new Date().getHours();
  let salutation = "Good morning";
  if (hour >= 12 && hour < 17) salutation = "Good afternoon";
  else if (hour >= 17) salutation = "Good evening";
  const firstName = (name || "").split(" ")[0] || "there";
  return `${salutation}, ${firstName} 👋`;
}

// ─── DOM references ───────────────────────────────────────────────────────────
const avatarImg       = document.getElementById("profile-avatar");
const greetingEl      = document.getElementById("profile-greeting");
const nameEl          = document.getElementById("profile-name");
const emailEl         = document.getElementById("profile-email");
const phoneTextEl     = document.getElementById("profile-phone-text");
const locationEl      = document.getElementById("profile-location");
const bioEl           = document.getElementById("profile-bio");
const cameraBtn       = document.getElementById("camera-btn");
const photoInput      = document.getElementById("profile-photo-input");
const logoutBtn       = document.querySelector(".logout-btn");

// ─── Populate UI from Firestore data ─────────────────────────────────────────
function populateProfile(data) {
  if (!data) return;

  const name     = data.name     || "No name set";
  const email    = data.email    || "No email set";
  const phone    = data.phone    || "No phone set";
  const location = data.location || "No location set";
  const bio      = data.bio      || "";
  const photo    = data.profileImage || "";

  if (greetingEl)   greetingEl.textContent  = buildGreeting(name);
  if (nameEl)       nameEl.textContent       = name;
  if (emailEl)      emailEl.textContent      = email;
  if (phoneTextEl)  phoneTextEl.textContent  = phone;
  if (locationEl)   locationEl.textContent   = location;
  if (bioEl)        bioEl.textContent        = bio;

  if (avatarImg) {
    // Only update src if it has actually changed to avoid flash
    const target = photo || buildDefaultAvatarUrl(name);
    if (avatarImg.src !== target) {
      avatarImg.src = target;
    }
  }
}

function buildDefaultAvatarUrl(name) {
  const encoded = encodeURIComponent((name || "User").slice(0, 2).toUpperCase());
  return `https://ui-avatars.com/api/?background=e03030&color=fff&size=128&name=${encoded}`;
}

// ─── Avatar error fallback ────────────────────────────────────────────────────
if (avatarImg) {
  avatarImg.addEventListener("error", () => {
    avatarImg.src = DEFAULT_AVATAR;
  });
}

// ─── Profile photo upload ─────────────────────────────────────────────────────
let currentUserId = null;

function setCameraLoading(isLoading) {
  if (!cameraBtn) return;
  cameraBtn.disabled = isLoading;
  cameraBtn.style.opacity = isLoading ? "0.5" : "1";
  cameraBtn.style.cursor  = isLoading ? "not-allowed" : "pointer";
}

async function handlePhotoUpload(file) {
  if (!currentUserId) {
    showToast("You must be logged in to change your photo.", "error");
    return;
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    showToast("Image must be smaller than 5 MB.", "error");
    return;
  }

  if (!file.type.startsWith("image/")) {
    showToast("Please select a valid image file.", "error");
    return;
  }

  // Preview immediately using a local object URL
  const previewUrl = URL.createObjectURL(file);
  if (avatarImg) avatarImg.src = previewUrl;

  setCameraLoading(true);

  try {
    const storagePath = `customers/${currentUserId}/profileImage`;
    const fileRef     = ref(firebaseStorage, storagePath);
    await uploadBytes(fileRef, file, { contentType: file.type });
    const downloadUrl = await getDownloadURL(fileRef);

    // Persist to Firestore so onSnapshot propagates it everywhere
    const customerDoc = doc(firebaseDb, CUSTOMERS_COLLECTION, currentUserId);
    await updateDoc(customerDoc, { profileImage: downloadUrl });

    showToast("Profile photo updated!", "success");
  } catch (err) {
    console.error("Photo upload failed:", err);
    showToast("Failed to upload photo. Please try again.", "error");
    // Revert preview to whatever is currently in Firestore
    if (avatarImg) avatarImg.src = DEFAULT_AVATAR;
  } finally {
    setCameraLoading(false);
    // Reset input so the same file can be re-selected
    if (photoInput) photoInput.value = "";
    URL.revokeObjectURL(previewUrl);
  }
}

if (cameraBtn && photoInput) {
  cameraBtn.addEventListener("click", () => photoInput.click());
  photoInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handlePhotoUpload(file);
  });
}

// ─── Logout ───────────────────────────────────────────────────────────────────
if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    const confirmed = window.confirm("Are you sure you want to log out?");
    if (!confirmed) return;

    logoutBtn.textContent = "Logging out…";
    logoutBtn.disabled = true;

    try {
      const { services: { sessionService } } = getAppContainer();
      await sessionService.logout();
    } catch (err) {
      console.error("Logout error:", err);
    } finally {
      window.location.href = LOGIN_URL;
    }
  });
}

// ─── Bottom-nav active state ──────────────────────────────────────────────────
function initBottomNav() {
  const navItems = document.querySelectorAll(".bottom-nav .nav-item");
  navItems.forEach((item) => {
    item.addEventListener("click", () => {
      navItems.forEach((n) => {
        n.classList.remove("active");
        const lbl = n.querySelector("span");
        if (lbl) lbl.classList.remove("active-label");
        n.querySelectorAll("path, circle, polyline, line, rect, polygon").forEach((p) =>
          p.setAttribute("stroke", "#aaa")
        );
      });

      item.classList.add("active");
      const span = item.querySelector("span");
      if (span) span.classList.add("active-label");
      item.querySelectorAll("path, circle, polyline, line, rect, polygon").forEach((p) =>
        p.setAttribute("stroke", "#e03030")
      );
    });
  });
}

// ─── Auth guard + Firestore real-time listener ────────────────────────────────
let unsubscribeSnapshot = null;

onAuthStateChanged(firebaseAuth, (user) => {
  if (!user) {
    // Not authenticated — redirect to login
    window.location.href = LOGIN_URL;
    return;
  }

  currentUserId = user.uid;

  // Clean up any previous listener before registering a new one
  if (unsubscribeSnapshot) unsubscribeSnapshot();

  const customerDoc = doc(firebaseDb, CUSTOMERS_COLLECTION, user.uid);

  unsubscribeSnapshot = onSnapshot(
    customerDoc,
    (snapshot) => {
      if (snapshot.exists()) {
        populateProfile(snapshot.data());
      } else {
        // Document not yet created — use what Firebase Auth provides
        populateProfile({
          name:  user.displayName || "",
          email: user.email       || "",
          phone: user.phoneNumber || ""
        });
      }
    },
    (err) => {
      console.error("Profile snapshot error:", err);
      showToast("Could not load profile data.", "error");
    }
  );

  initBottomNav();
});
