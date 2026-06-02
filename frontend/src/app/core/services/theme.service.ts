import { Injectable, effect, signal } from '@angular/core';

export type ThemeId = 'midnight' | 'dark' | 'light';

export interface ThemeOption {
  id: ThemeId;
  label: string;
  description: string;
  /** Swatch colours shown in the picker (surface, accent). */
  swatch: [string, string];
}

// Bumped to v2 so the previous indigo-default era's stored 'midnight'
// preference is retired and users fall back to the new 'light' default.
const STORAGE_KEY = 'ok_theme_v2';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  /** Catalogue of selectable themes, used to render the settings picker. */
  readonly themes: readonly ThemeOption[] = [
    {
      id: 'midnight',
      label: 'Midnight',
      description: 'Deep-space indigo',
      swatch: ['#0b1326', '#6366f1'],
    },
    {
      id: 'dark',
      label: 'Dark',
      description: 'Neutral charcoal',
      swatch: ['#0e0e10', '#10b981'],
    },
    {
      id: 'light',
      label: 'Light',
      description: 'Clean white',
      swatch: ['#ffffff', '#f59e0b'],
    },
  ];

  readonly theme = signal<ThemeId>(this.loadInitial());

  constructor() {
    // Keep the document attribute in sync with the signal. Runs immediately
    // on construction so the stored theme is applied before first paint.
    effect(() => {
      const theme = this.theme();
      try {
        document.documentElement.setAttribute('data-theme', theme);
        const iconHref = theme === 'light' ? 'openknowledge_icon.svg' : 'openknowledge_icon_white.svg';
        const link = document.querySelector("link[rel*='icon']") as HTMLLinkElement | null;
        if (link) {
          link.href = iconHref;
        }
      } catch {
        /* non-browser environment — ignore */
      }
    });
  }

  setTheme(theme: ThemeId): void {
    this.theme.set(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* storage unavailable — ignore */
    }
  }

  /** Cycle to the next theme in the catalogue (wraps around). */
  toggle(): void {
    const ids = this.themes.map(t => t.id);
    const next = ids[(ids.indexOf(this.theme()) + 1) % ids.length];
    this.setTheme(next);
  }

  private loadInitial(): ThemeId {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'midnight' || stored === 'dark' || stored === 'light') {
        return stored;
      }
    } catch {
      /* storage unavailable — ignore */
    }
    return 'light';
  }
}
