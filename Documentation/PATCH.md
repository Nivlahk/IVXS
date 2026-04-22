# Integration patch for index.html
# Two changes needed. Everything else in index.html stays identical.

# ── CHANGE 1: Add the CSS link in <head> ──────────────────────────────────────
# After the existing:
#   <link rel="stylesheet" href="styles.css">
# Add:
  <link rel="stylesheet" href="ivx-demos.css">


# ── CHANGE 2: Add the script tag at the bottom of <body> ─────────────────────
# After the existing three scripts:
#   <script src="ivx-core.js"></script>
#   <script src="ivx-runtime.js"></script>
#   <script src="ivx-render.js"></script>
# Add:
  <script src="ivx-demos.js"></script>


# ── NOTHING ELSE in index.html needs to change ───────────────────────────────
# The existing #help-menu-btn, #help-menu, and all .hm-btn elements stay in the
# HTML — ivx-demos.js hides #help-menu via JS and rewires the button.
# This means the old behaviour is preserved as a fallback if ivx-demos.js
# fails to load (e.g. during development without a server).
