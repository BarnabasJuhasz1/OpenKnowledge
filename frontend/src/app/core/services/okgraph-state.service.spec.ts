import { describe, beforeEach, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { OkGraphStateService } from './okgraph-state.service';

describe('OkGraphStateService', () => {
  let service: OkGraphStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [OkGraphStateService]
    });
    service = TestBed.inject(OkGraphStateService);
  });

  it('should initialize panelCollapsed and autoOpenEnabled to true', () => {
    expect(service.panelCollapsed()).toBe(true);
    expect(service.autoOpenEnabled()).toBe(true);
  });

  it('should reset panelCollapsed and autoOpenEnabled to true on clear()', () => {
    service.panelCollapsed.set(false);
    service.autoOpenEnabled.set(false);

    expect(service.panelCollapsed()).toBe(false);
    expect(service.autoOpenEnabled()).toBe(false);

    service.clear();

    expect(service.panelCollapsed()).toBe(true);
    expect(service.autoOpenEnabled()).toBe(true);
  });
});
