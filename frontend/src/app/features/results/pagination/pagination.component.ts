import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';

@Component({
  selector: 'app-pagination',
  standalone: true,
  templateUrl: './pagination.component.html',
  styleUrl: './pagination.component.scss',
})
export class PaginationComponent implements OnChanges {
  @Input({ required: true }) totalItems = 0;
  @Input() pageSize = 10;
  @Input({ required: true }) currentPage = 1;
  @Output() pageChange = new EventEmitter<number>();

  pages: (number | '...')[] = [];
  totalPages = 0;

  ngOnChanges(_changes: SimpleChanges): void {
    this.totalPages = Math.ceil(this.totalItems / this.pageSize);
    this.pages = this.buildPages();
  }

  private buildPages(): (number | '...')[] {
    const total = this.totalPages;
    const cur = this.currentPage;
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

    const pages: (number | '...')[] = [1];
    if (cur > 3) pages.push('...');
    const start = Math.max(2, cur - 1);
    const end = Math.min(total - 1, cur + 1);
    for (let i = start; i <= end; i++) pages.push(i);
    if (cur < total - 2) pages.push('...');
    pages.push(total);
    return pages;
  }

  go(page: number | '...'): void {
    if (page === '...') return;
    if (page < 1 || page > this.totalPages || page === this.currentPage) return;
    this.pageChange.emit(page);
  }

  prev(): void { this.go(this.currentPage - 1); }
  next(): void { this.go(this.currentPage + 1); }
}
