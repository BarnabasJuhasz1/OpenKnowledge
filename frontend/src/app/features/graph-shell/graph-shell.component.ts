import { Component } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';

@Component({
  selector: 'app-graph-shell',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './graph-shell.component.html',
  styleUrl: './graph-shell.component.scss',
})
export class GraphShellComponent {}
