import { Component, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NotificationService } from './core/services/notification.service';
import { ThemeService } from './core/services/theme.service';
import { TopNavComponent } from './shared/components/top-nav/top-nav.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, TopNavComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  protected readonly title = signal('openknowledge');
  protected readonly notifications = inject(NotificationService);
  // Eagerly instantiate so its effect applies the stored/default theme
  // (data-theme on <html>) at startup, not just when Settings is opened.
  private readonly theme = inject(ThemeService);
}
