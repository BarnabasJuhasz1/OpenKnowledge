# Feature: Switchable App Theme (Midnight ⇄ Dark)

## Goal
Let the user switch the in-app color scheme between the current blue
"Midnight" theme and a new, non-blue, traditional neutral "Dark" theme.
Expose the switch from a new **Settings** section at the bottom of the
dashboard sidebar. Persist the choice across sessions.

## Subtasks

### 1. Make global styles theme-aware
- The current `:root` block stays as the **Midnight** (default) theme.
- Replace the few hard-coded indigo literals in global utility classes
  (`mesh-gradient`, `::selection`, primary glow shadow) with CSS variables
  so they respond to the active theme.
- Add a `:root[data-theme='dark']` block defining a neutral charcoal/zinc
  surface palette with an emerald/teal accent (deliberately not blue).
- Keep `.landing-theme` untouched (landing page light palette is scoped to
  its own subtree and is unaffected by the app theme attribute).

### 2. ThemeService
- `core/services/theme.service.ts`, `providedIn: 'root'`.
- Signal `theme: 'midnight' | 'dark'`, default `'midnight'`.
- Persist to `localStorage` under `ok_theme`.
- `effect()` writes `data-theme` onto `document.documentElement`.
- Expose `setTheme()` / `toggle()` plus a `themes` descriptor list for the UI.

### 3. Settings tab in sidebar
- Add a bottom-pinned Settings block to the dashboard sidebar.
- Render an "Appearance" theme switcher with the two options
  (Midnight / Dark), highlighting the active one.
- Inject `ThemeService` into `DashboardComponent`.
- Sidebar uses flex column so Settings sticks to the bottom; responsive
  layout (mobile) keeps it inline.

### 4. Verify
- `npm run build` succeeds with no template/SCSS errors.
- Manual reasoning: switching sets `data-theme`, variables cascade, choice
  survives reload via localStorage.

## Notes
- Component-level accent literals (`#6366f1` dots/shadows) remain; the
  theme-aware surfaces + gradient variables carry the visual switch.

## Follow-up (round 2)
### 5. Full accent-literal extraction
- Added RGB-triplet + hover variables to both themes:
  `--ok-primary-rgb` / `--ok-secondary-rgb` / `--ok-tertiary-rgb`,
  `--ok-primary-raw-hover`.
- Swept every component `.scss` so indigo/purple/blue literals
  (`#6366f1`, `rgba(99,102,241,*)`, `#4f46e5`, `#a855f7`, `#0ea5e9`, …)
  now reference theme variables. `$brand*` SCSS vars repoint to CSS vars.
- Project-dot fallbacks in HTML use `var(--ok-primary-raw)`.
- **Left fixed on purpose:** categorical data palettes (graph community
  colors, project color picker, docs distribution-bar palette) and the
  theme-preview swatches in `ThemeService` — these encode meaning, not
  chrome, so they must not shift with the theme.

### 6. Settings moved into its own tab
- New `features/settings/` page hosts the Appearance theme picker (the
  Midnight/Dark visuals now live here, not at the sidebar bottom).
- Route `dashboard/settings`; the sidebar bottom is now a Settings
  **nav link** that routes into the tab.

## Follow-up (round 3)
### 7. Light (white) theme
- Added `:root[data-theme='light']` — white/light-gray surfaces, dark
  text, indigo/purple brand accents kept.
- Added `ThemeId 'light'` + catalogue entry + storage validation;
  `toggle()` now cycles the whole catalogue.
- Introduced `--ok-hover-overlay` / `--ok-hover-overlay-strong` (white on
  dark themes, black on light) and repointed the dark-first
  `rgba(255,255,255,0.05/.06/.1)` hover backgrounds to them so hovers stay
  visible on white (sidebar, top-nav, graph-shell, prompt-keywords).
- Known limitation: a few intentional white borders/decorations remain
  hard-coded; they read faint on light but don't break layout.
