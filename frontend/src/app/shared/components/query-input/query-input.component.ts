import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-query-input',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './query-input.component.html',
  styleUrl: './query-input.component.scss',
})
export class QueryInputComponent implements OnChanges {
  @Input() initialQuery = '';
  @Input() loading = false;
  @Output() search = new EventEmitter<string>();

  query = signal('');

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['initialQuery']) {
      this.query.set(this.initialQuery);
    }
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      this.submit();
    }
  }

  submit(): void {
    const q = this.query().trim();
    if (q && !this.loading) {
      this.search.emit(q);
    }
  }
}
