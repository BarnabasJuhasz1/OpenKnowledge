import { Component, Input } from '@angular/core';
import { Paper } from '../../../core/models/paper.model';
import { PaperCardComponent } from '../paper-card/paper-card.component';

const PAGE_SIZE = 10;

@Component({
  selector: 'app-paper-list',
  standalone: true,
  imports: [PaperCardComponent],
  templateUrl: './paper-list.component.html',
  styleUrl: './paper-list.component.scss',
})
export class PaperListComponent {
  @Input({ required: true }) papers: Paper[] = [];
  @Input({ required: true }) page = 1;

  get pagePapers(): Paper[] {
    const start = (this.page - 1) * PAGE_SIZE;
    return this.papers.slice(start, start + PAGE_SIZE);
  }
}
