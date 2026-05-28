import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'ok_demo_mode';

@Injectable({ providedIn: 'root' })
export class DemoModeService {
  readonly enabled = signal(this.loadInitial());

  toggle(): void {
    const next = !this.enabled();
    this.enabled.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch { /* storage unavailable */ }
  }

  private loadInitial(): boolean {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored !== null) return JSON.parse(stored);
    } catch { /* storage unavailable */ }
    return true;
  }
}
