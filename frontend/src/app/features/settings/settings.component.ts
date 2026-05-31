import { Component, inject } from '@angular/core';
import { ThemeService, ThemeId } from '../../core/services/theme.service';

@Component({
  selector: 'app-settings',
  standalone: true,
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent {
  private readonly themeService = inject(ThemeService);

  readonly themes = this.themeService.themes;
  readonly activeTheme = this.themeService.theme;

  setTheme(theme: ThemeId): void {
    this.themeService.setTheme(theme);
  }
}
