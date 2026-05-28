import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  message: string;
}

@Injectable({ providedIn: 'root' })
export class NotificationService {
  readonly toasts = signal<Toast[]>([]);
  private nextId = 0;

  show(message: string, durationMs = 3000): void {
    const id = this.nextId++;
    this.toasts.update(prev => [...prev, { id, message }]);
    setTimeout(() => this.dismiss(id), durationMs);
  }

  dismiss(id: number): void {
    this.toasts.update(prev => prev.filter(t => t.id !== id));
  }
}
