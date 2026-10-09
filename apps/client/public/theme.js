// Runs before parsing the app so the saved choice reaches the first paint.
// src/ui/theme.ts owns subsequent changes and cross-tab synchronization.
(() => {
  try {
    const theme = localStorage.getItem("vaskel.theme");
    if (theme === "light" || theme === "dark")
      document.documentElement.dataset.theme = theme;
  } catch {
    // Storage can be unavailable; CSS still follows the system preference.
  }
})();
