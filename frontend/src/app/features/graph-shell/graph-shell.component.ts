import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-graph-shell',
  standalone: true,
  imports: [RouterOutlet],
  templateUrl: './graph-shell.component.html',
  styleUrl: './graph-shell.component.scss',
})
export class GraphShellComponent {}
